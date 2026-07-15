import { MysqlError, createConnection, Connection as MysqlConnection } from 'mysql'
import Monitor from '../classes/monitor'
import { Connection } from '../classes/connection'
import MonitorData from '../classes/monitordata'
const config = require('../../config/config.json')

let connection: MysqlConnection

/**
 * (Re)establish the MySQL connection. MySQL can drop idle connections (wait_timeout)
 * or reset the socket; without an 'error' handler that's an uncaught exception that
 * crashes the whole bot, not just the DB layer. Reconnect instead of letting that happen.
 */
function connect () {
  connection = createConnection({
    host: config.database.host,
    user: config.database.user,
    password: config.database.password,
    database: config.database.database
  })

  connection.connect((err) => { if (err != null) setTimeout(connect, 2000) })
  connection.on('error', (err: MysqlError) => {
    console.error('MySQL connection error:', err)
    if (err.fatal) connect()
  })
}

connect()

/**
 * Migrate the database and ensure all tables exist.
 */
async function migrate (): Promise<void> {
  await connection.query('CREATE TABLE IF NOT EXISTS connections (id INT AUTO_INCREMENT PRIMARY KEY, host VARCHAR(255), port INT, game VARCHAR(255), player VARCHAR(255), channel VARCHAR(255), session VARCHAR(255) NULL)')
  await connection.query('CREATE TABLE IF NOT EXISTS activity_log (id INT AUTO_INCREMENT PRIMARY KEY, guild_id VARCHAR(255), user_id VARCHAR(255), action VARCHAR(255), timestamp DATETIME)')

  // Add the session column for installs that were created before this field existed.
  // Wrapped in a try/catch since some MySQL versions don't support "ADD COLUMN IF NOT EXISTS".
  try {
    await connection.query('ALTER TABLE connections ADD COLUMN IF NOT EXISTS session VARCHAR(255) NULL')
  } catch (err) {
    // Column likely already exists, or the SQL server doesn't support this syntax. Safe to ignore.
  }
}

async function createLog (guildId: string, userId: string, action: string) {
  await connection.query('INSERT INTO activity_log (guild_id, user_id, action, timestamp) VALUES (?, ?, ?, NOW())', [guildId, userId, action])
}

function getConnections (): Promise<Connection[]> {
  return new Promise((resolve, reject) => {
    connection.query('SELECT * FROM connections', (err: MysqlError, results: Connection[]) => {
      if (err) reject(err)
      resolve(results)
    })
  })
}

/**
 * Store a new multiworld connection in the database.
 * @param data The data to store.
 * @returns
 */
function makeConnection (data: MonitorData): Promise<void> {
  return new Promise((resolve, reject) => {
    connection.query('INSERT INTO connections (host, port, game, player, channel, session) VALUES (?, ?, ?, ?, ?, ?)', [data.host, data.port, data.game, data.player, data.channel, data.session ?? null], (err, results) => {
      if (err) reject(err)
      resolve(results)
    })
  })
}

/**
 * Remove a specifed connection from the database.
 * @param monitor
 * @returns
 */
function removeConnection (monitor: Monitor) {
  return new Promise((resolve, reject) => {
    connection.query('DELETE FROM connections WHERE host = ? AND port = ? AND game = ? AND player = ? AND channel = ?', [monitor.data.host, monitor.data.port, monitor.data.game, monitor.data.player, monitor.channel.id], (err, results) => {
      if (err) reject(err)
      resolve(results)
    })
  })
}

const Database = {
  getConnections,
  makeConnection,
  removeConnection,
  createLog,
  migrate
}

export default Database
