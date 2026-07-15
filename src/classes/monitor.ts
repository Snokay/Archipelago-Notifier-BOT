import { EmbedBuilder, Guild, TextBasedChannel, Client as DiscordClient, GuildChannel } from 'discord.js'
import { BouncedPacket, Client, CollectJSONPacket, ConnectionInformation, DeathLinkData, HintJSONPacket, ITEMS_HANDLING_FLAGS, ItemSendJSONPacket, PrintJSONPacket, SERVER_PACKET_TYPE, SlotData } from 'archipelago.js'
import MonitorData from './monitordata'
import RandomHelper from '../utils/randohelper'

const RECONNECT_BASE_DELAY = 5000 // 5 seconds
const RECONNECT_MAX_DELAY = 300000 // 5 minutes
const GIVE_UP_AFTER = 4 * 24 * 60 * 60 * 1000 // 4 days

export default class Monitor {
  client: Client<SlotData>
  channel: TextBasedChannel
  guild: Guild
  data: MonitorData

  /** Set by whoever creates this monitor, to be told when it gives up reconnecting for good. */
  onGiveUp?: () => void

  isReconnecting: boolean
  reconnectDelay = RECONNECT_BASE_DELAY
  private reconnectingSince?: number

  private readonly onDisconnectBound = this.onDisconnect.bind(this)
  private readonly onJSONBound = this.onJSON.bind(this)
  private readonly onBouncedBound = this.onBounced.bind(this)
  private readonly onSessionClosedBound = this.onSessionClosed.bind(this)

  queue = {
    hints: [] as string[],
    items: [] as string[]
  }

  convertData (message: ItemSendJSONPacket | CollectJSONPacket | HintJSONPacket) {
    return message.data.map((slot) => {
      switch (slot.type) {
        case 'player_id':
          return `**${this.client.players.get(parseInt(slot.text))?.name}**`
        case 'item_id':
          return `*${RandomHelper.getItem(this.client, slot.player, parseInt(slot.text), slot.flags)}*`
        case 'location_id':
          return `**${RandomHelper.getLocation(this.client, slot.player, parseInt(slot.text))}**`
        default:
          return slot.text
      }
    }).join(' ')
  }

  addQueue (message: string, type: 'hints' | 'items' = 'hints') {
    if (this.queue.hints.length === 0 && this.queue.items.length === 0) setTimeout(() => this.sendQueue(), 150)

    switch (type) {
      case 'hints':
        this.queue.hints.push(message)
        break
      case 'items':
        this.queue.items.push(message)
        break
    }
  }

  /** Prefixes a title with "Session X: " when a session label was provided to /monitor. */
  private titleWithSession (title: string): string {
    return this.data.session != null && this.data.session !== '' ? `Session ${this.data.session}: ${title}` : title
  }

  sendQueue () {
    const fields = this.queue.hints.map((message, index) => ({ name: `#${index + 1}`, value: message }))
    this.queue.hints = []
    // TEMP DEBUG - remove once the missing-hint issue is confirmed fixed.
    console.log('[sendQueue] hint fields:', JSON.stringify(fields))
    // split into multiple messages if there are too many items
    while (fields.length > 0) {
      const message = new EmbedBuilder().setTitle(this.titleWithSession('Hints')).addFields(fields.splice(0, 25)).data
      this.channel.send({ embeds: [message] }).catch((err) => console.error('[sendQueue] hint send() rejected:', err))
    }

    const items = this.queue.items.map((message, index) => ({ name: `#${index + 1}`, value: message }))
    this.queue.items = []
    // split into multiple messages if there are too many items
    while (items.length > 0) {
      const message = new EmbedBuilder().setTitle(this.titleWithSession('Items')).addFields(items.splice(0, 25)).data
      this.channel.send({ embeds: [message] })
    }
  }

  send (message: string) {
    // make an embed for the message
    const embed = new EmbedBuilder().setDescription(message).setTitle(this.titleWithSession('Archipelago'))
    this.channel.send({ embeds: [embed.data] })
  }

  constructor (client: Client<SlotData>, monitorData: MonitorData, discordClient: DiscordClient) {
    this.client = client
    this.data = monitorData

    this.channel = discordClient.channels.cache.get(monitorData.channel) as TextBasedChannel
    this.guild = (discordClient.channels.cache.get(monitorData.channel) as GuildChannel).guild
  }

  /**
   * (Re)attaches our event listeners to the underlying archipelago.js client. Must run after
   * every successful connect, not just once at construction: Client#disconnect() - called
   * internally by the library on *any* failed connection attempt, not just on a deliberate
   * disconnect - wipes every listener via removeAllListeners(). Without this, a reconnect that
   * needed more than one attempt would "succeed" (we'd post "Reconnected to the server.") while
   * silently never receiving another game event again. Removing before adding keeps this safe
   * to call even when a reconnect succeeded on the first try and nothing was ever wiped.
   */
  private attachListeners () {
    this.client.removeListener(SERVER_PACKET_TYPE.CONNECTION_REFUSED, this.onDisconnectBound)
    this.client.removeListener(SERVER_PACKET_TYPE.PRINT_JSON, this.onJSONBound)
    this.client.removeListener(SERVER_PACKET_TYPE.BOUNCED, this.onBouncedBound)
    this.client.addListener(SERVER_PACKET_TYPE.CONNECTION_REFUSED, this.onDisconnectBound)
    this.client.addListener(SERVER_PACKET_TYPE.PRINT_JSON, this.onJSONBound)
    this.client.addListener(SERVER_PACKET_TYPE.BOUNCED, this.onBouncedBound)

    // SessionClosed is a custom event added by our archipelago.js patch (see
    // patches/archipelago.js+1.1.0.patch) and isn't in the upstream types. It fires
    // whenever the socket closes on a previously-connected client - this includes the
    // room truly ending, but also just the local AP server being restarted for a new
    // game. We can't tell those apart, so we always try to reconnect rather than giving
    // up, since giving up would otherwise force a manual /monitor after every replay.
    const clientAny: any = this.client
    clientAny.removeListener('SessionClosed', this.onSessionClosedBound)
    clientAny.addListener('SessionClosed', this.onSessionClosedBound)
  }

  private connectionInfo (): ConnectionInformation {
    return {
      game: this.data.game,
      hostname: this.data.host,
      port: this.data.port,
      name: this.data.player,
      version: { major: 0, minor: 6, build: 7 },
      items_handling: ITEMS_HANDLING_FLAGS.REMOTE_ALL,
      tags: ['IgnoreGame', 'Tracker', 'Monitor', 'DeathLink']
    }
  }

  /**
   * Connects (or reconnects) with exponential backoff, capped at 5 minutes between attempts.
   * Used both for the very first connection and for every reconnect afterwards, so a session
   * that's never come up yet and one that dropped after working fine both get the same
   * treatment. Gives up (and calls `onGiveUp`) after 4 days of nothing but failures, as a
   * safety net for sessions that are gone for good and never got a manual /unmonitor.
   */
  connect (onSuccess?: () => void) {
    this.isReconnecting = true
    if (this.reconnectingSince == null) this.reconnectingSince = Date.now()

    this.client.connect(this.connectionInfo()).then(() => {
      this.isReconnecting = false
      this.reconnectDelay = RECONNECT_BASE_DELAY
      this.reconnectingSince = undefined
      this.attachListeners()
      onSuccess?.()
    }).catch(() => {
      if (this.reconnectingSince != null && Date.now() - this.reconnectingSince >= GIVE_UP_AFTER) {
        this.send('I haven\'t been able to reconnect in 4 days, so I\'ve stopped trying. Use /monitor again if this session comes back.')
        this.isReconnecting = false
        this.onGiveUp?.()
        return
      }

      setTimeout(() => this.connect(onSuccess), this.reconnectDelay)
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_DELAY)
    })
  }

  onDisconnect () {
    this.send('Disconnected from the server.')
    if (this.isReconnecting) return
    this.connect(() => this.send('Reconnected to the server.'))
  }

  onSessionClosed () {
    this.send('This Archipelago session has closed. Attempting to reconnect...')
    if (this.isReconnecting) return
    this.connect(() => this.send('Reconnected to the server.'))
  }

  // When a message is received from the server
  onJSON (packet: PrintJSONPacket) {
    switch (packet.type) {
      case 'Collect':
      case 'ItemSend':
        this.addQueue(this.convertData(packet), 'items')
        break
      case 'Hint':
        // TEMP DEBUG - remove once the missing-hint issue is confirmed fixed.
        console.log('[Hint] raw packet:', JSON.stringify(packet))
        console.log('[Hint] converted message:', JSON.stringify(this.convertData(packet)))
        this.addQueue(this.convertData(packet), 'hints')
        break
      case 'Join':
        // Overrides for special join messages
        if (packet.tags.includes('Monitor')) return
        if (packet.tags.includes('IgnoreGame')) {
          this.send(`A tracker for **${this.client.players.get(packet.slot)?.name}** has joined the game!`)
          return
        };;

        this.send(`**${this.client.players.get(packet.slot)?.name}** (${this.client.players.get(packet.slot)?.game}) joined the game!`)
        break
      case 'Part':
        this.send(`**${this.client.players.get(packet.slot)?.name}** (${this.client.players.get(packet.slot)?.game}) left the game!`)
        break
    }
  }

  // DeathLink deaths arrive as Bounced packets tagged "DeathLink" (see the "DeathLink" connect tag above).
  onBounced (packet: BouncedPacket) {
    if (packet.tags == null || !packet.tags.includes('DeathLink')) return

    const data = packet.data as unknown as DeathLinkData
    this.send(data.cause != null && data.cause !== '' ? `💀 ${data.cause}` : `💀 **${data.source}** died.`)
  }
}
