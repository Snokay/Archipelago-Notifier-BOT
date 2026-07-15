import MonitorData from '../classes/monitordata'
import { Client, ConnectionInformation, ITEMS_HANDLING_FLAGS } from 'archipelago.js'
import Monitor from '../classes/monitor'
import { Client as DiscordClient } from 'discord.js'
import Database from './database'

const monitors: Monitor[] = []

/**
 * Remove a monitor from memory and the database. Only used for manual /unmonitor -
 * a session closing on its own no longer forgets the monitor, it reconnects instead
 * (see Monitor#onSessionClosed).
 */
function forget (monitor: Monitor, reason: string) {
  const index = monitors.indexOf(monitor)
  if (index === -1) return
  monitors.splice(index, 1)
  monitor.client.disconnect()
  Database.removeConnection(monitor)
  Database.createLog(monitor.guild.id, '0', `Stopped tracking ${monitor.data.host}:${monitor.data.port} (${reason})`)
}

function make (data: MonitorData, client: DiscordClient): Promise<Monitor> {
  return new Promise<Monitor>((resolve, reject) => {
    const archi = new Client()
    const connectionInfo: ConnectionInformation = {
      hostname: data.host,
      port: data.port,
      game: data.game,
      name: data.player,
      version: { major: 0, minor: 6, build: 7 },
      items_handling: ITEMS_HANDLING_FLAGS.REMOTE_ALL,
      tags: ['IgnoreGame', 'Tracker', 'Monitor', 'DeathLink']
    }

    archi.connect(connectionInfo).then(() => {
      const monitor = new Monitor(archi, data, client)
      Database.createLog(monitor.guild.id, '0', `Connected to ${data.host}:${data.port}`)
      monitors.push(monitor)

      resolve(monitor)
    }).catch((err) => { console.log(err) })
  })
}

function remove (host: string) {
  const monitor = monitors.find((monitor) => monitor.client.uri?.includes(host))
  if (monitor == null) return
  forget(monitor, 'manually unmonitored')
}

function has (host: string) {
  return monitors.some((monitor) => monitor.client.uri?.includes(host))
}

function get (guild: string) {
  return monitors.filter((monitor) => monitor.guild.id === guild)
}

const Monitors = {
  make,
  remove,
  has,
  get
}

export default Monitors
