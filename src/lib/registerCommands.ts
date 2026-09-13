import { PermissionFlagsBits, REST, Routes } from 'discord.js';
import {
  permissionLevelsForCommand,
  rolesForLevel,
  type PermissionLevel,
  type SellBotConfig
} from '../botConfig.js';
import { commands } from '../commands/index.js';
import type { BotConfig } from '../config.js';

function isVisibleWithoutManageGuild(botConfig: SellBotConfig, level: PermissionLevel): boolean {
  return level === 'everyone' || rolesForLevel(botConfig, level).length > 0;
}

/**
 * Decides which members see a command by default. Discord visibility applies
 * to the whole command, so the most permissive level among the command and
 * its subcommand overrides wins; SellBot enforces the exact levels at runtime.
 */
function defaultMemberPermissions(botConfig: SellBotConfig, commandName: string): bigint | null {
  const levels = permissionLevelsForCommand(botConfig, commandName);
  return levels.some((level) => isVisibleWithoutManageGuild(botConfig, level))
    ? null
    : PermissionFlagsBits.ManageGuild;
}

/**
 * Registers all slash commands with Discord, either to the configured guild
 * (available immediately, used for testing) or globally (can take up to an
 * hour to propagate) if no guild is configured.
 */
export async function registerCommands(config: BotConfig, botConfig: SellBotConfig): Promise<void> {
  const unconfiguredCommands = commands
    .map((command) => command.data.name)
    .filter((name) => botConfig.commandPermissions[name] === undefined);
  if (unconfiguredCommands.length > 0) {
    console.warn(
      `Warning: no commandPermissions entry in config.json for: ${unconfiguredCommands.join(', ')}. ` +
        'These commands default to the "admin" level.'
    );
  }

  const rest = new REST().setToken(config.discordToken);
  const body = commands.map((command) =>
    command.data
      .setDefaultMemberPermissions(defaultMemberPermissions(botConfig, command.data.name))
      .toJSON()
  );

  if (config.discordGuildId === undefined) {
    await rest.put(Routes.applicationCommands(config.discordClientId), { body });
    console.log(`Registered ${body.length} slash commands globally.`);
    console.log('Note: global commands can take up to an hour to appear in Discord.');
  } else {
    await rest.put(
      Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId),
      { body }
    );
    console.log(
      `Registered ${body.length} slash commands to guild ${config.discordGuildId} (available immediately).`
    );
  }
}
