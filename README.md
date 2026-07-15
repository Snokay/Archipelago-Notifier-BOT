# Archipelago Notifier (self-hosted fork)

## Summary

This is a Discord bot for monitoring [Archipelago](https://archipelago.gg) that keeps track of your session and reports all items you've collected to any Discord server of your choice for your friends or teammates to be notified of.

It supports any game, and provides a rich set of embeds for each event that it displays.

## Supported Events

The bot supports the following events to display in Discord:

- Player Join
- Player Leave
- Item Send
- Hint
- DeathLink

## Getting started (self-hosted)

Create your own Discord application and bot at the [Discord Developer Portal](https://discord.com/developers/applications), invite it to your server with the `bot` and `applications.commands` scopes, then fill in `config/config.json` with your bot token, database credentials, and log channel ID.

See the deployment notes below for setup on a VPS.

Once you've added the bot, you can begin monitoring a session using the `/monitor` command followed by the displayed arguments.

The required arguments include: `game`, `player`, `host`, `port`

You can then stop monitoring a session at any time using `/unmonitor`

