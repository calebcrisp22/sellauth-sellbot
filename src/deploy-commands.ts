import { loadBotConfig } from './botConfig.js';
import { loadConfig } from './config.js';
import { registerCommands } from './lib/registerCommands.js';

const config = loadConfig();
const botConfig = loadBotConfig();

try {
  await registerCommands(config, botConfig);
} catch (error) {
  console.error('Failed to register slash commands:', error);
  process.exit(1);
}
