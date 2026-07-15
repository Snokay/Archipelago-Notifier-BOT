import MonitorData from '../classes/monitordata'
import { Client } from 'archipelago.js'
import Monitor from '../classes/monitor'
import { Client as DiscordClient } from 'discord.js'
import Database from './database'

const monitors: Monitor[] = []

/**
 * Stable identifier for a monitor. Deliberately not `monitor.client.uri` - that getter
 * can be undefined depending on the underlying socket's state (e.g. mid-reconnect), and
 * an empty autocomplete choice name makes Discord silently reject the whole choices list.
 */
function identifier (monitor: Monitor): string {
  return `${monitor.data.host}:${monitor.data.port}`
}

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

/**
 * Registers the monitor immediately (even before the connection succeeds) so it's visible
 * to /unmonitor and to the duplicate-host check right away, and lets it retry indefinitely
 * via Monitor#connect instead of giving up silently on the first failed attempt - which
 * previously meant a session that wasn't reachable yet (e.g. restored on bot startup before
 * the game server was up) never got tracked or retried at all.
 */
function make (data: MonitorData, client: DiscordClient): Promise<Monitor> {
  return new Promise<Monitor>((resolve) => {
    const archi = new Client()
    const monitor = new Monitor(archi, data, client)
    monitor.onGiveUp = () => forget(monitor, 'gave up reconnecting after 4 days')
    monitors.push(monitor)

    monitor.connect(() => {
      Database.createLog(monitor.guild.id, '0', `Connected to ${data.host}:${data.port}`)
      resolve(monitor)
    })
  })
}

function remove (host: string) {
  const monitor = monitors.find((monitor) => identifier(monitor) === host)
  if (monitor == null) return
  forget(monitor, 'manually unmonitored')
}

function has (host: string) {
  return monitors.some((monitor) => identifier(monitor) === host)
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
