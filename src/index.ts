import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client as ReadyDiscordClient
} from 'discord.js';
import { loadBotConfig } from './botConfig.js';
import { commands } from './commands/index.js';
import type { Command, CommandContext } from './commands/types.js';
import { loadConfig } from './config.js';
import {
  CUSTOMER_PAGE_BUTTON_PREFIX,
  handleCustomerPageButton
} from './commands/customer.js';
import {
  CLAIM_ORDER_BUTTON_ID,
  CLAIM_ORDER_MODAL_ID,
  handleClaimOrderModal,
  openClaimOrderModal
} from './lib/claimInteractions.js';
import { evaluateAccess } from './lib/permissions.js';
import { registerCommands } from './lib/registerCommands.js';
import { SellAuthApiError, SellAuthClient } from './sellauth/client.js';

const config = loadConfig();
const botConfig = loadBotConfig();

const sellAuth = new SellAuthClient({
  apiKey: config.sellAuthApiKey,
  shopId: config.sellAuthShopId,
  baseUrl: config.sellAuthBaseUrl
});

const context: CommandContext = { sellAuth, botConfig };

const commandsByName = new Map<string, Command>(
  commands.map((command) => [command.data.name, command])
);

// GuildMessages + MessageContent are needed by /restock to read the keys message.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

function userFacingErrorMessage(error: unknown): string {
  if (error instanceof SellAuthApiError) {
    if (error.status === 401 || error.status === 403) {
      return 'SellAuth rejected the API key. Check SELLAUTH_API_KEY and SELLAUTH_SHOP_ID.';
    }
    if (error.status === 429) {
      return 'SellAuth is rate limiting the bot. Try again in a moment.';
    }
    return 'The SellAuth API returned an error. Try again later.';
  }
  return 'Something went wrong while running this command.';
}

async function replyWithError(
  interaction: ChatInputCommandInteraction,
  error: unknown
): Promise<void> {
  const content = userFacingErrorMessage(error);
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content });
  } else {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
}

const STATUS_MESSAGES = ['Made for sellauth.com', 'Made by barkiedev.cc'] as const;
const STATUS_ROTATION_MS = 30_000;

function startStatusRotation(readyClient: ReadyDiscordClient<true>): void {
  let statusIndex = 0;

  const applyStatus = (): void => {
    const message = STATUS_MESSAGES[statusIndex % STATUS_MESSAGES.length];
    if (message !== undefined) {
      readyClient.user.setActivity(message, { type: ActivityType.Watching });
    }
    statusIndex += 1;
  };

  applyStatus();
  setInterval(applyStatus, STATUS_ROTATION_MS);
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`SellBot is online as ${readyClient.user.tag}`);
  startStatusRotation(readyClient);

  registerCommands(config, botConfig)
    .then(() => {
      console.log('Slash command registration complete.');
    })
    .catch((error: unknown) => {
      console.error('Failed to register slash commands:', error);
    });
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    if (interaction.customId === CLAIM_ORDER_BUTTON_ID) {
      try {
        await openClaimOrderModal(interaction);
      } catch (error) {
        console.error('Failed to open the claim-order modal:', error);
      }
    } else if (interaction.customId.startsWith(CUSTOMER_PAGE_BUTTON_PREFIX)) {
      try {
        await handleCustomerPageButton(interaction, context);
      } catch (error) {
        console.error('Customer pagination failed:', error);
      }
    }
    return;
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === CLAIM_ORDER_MODAL_ID) {
      try {
        await handleClaimOrderModal(interaction, context);
      } catch (error) {
        console.error('Claim-order modal submission failed:', error);
        if (interaction.deferred) {
          await interaction
            .editReply({ content: 'Something went wrong while claiming your order. Try again later.' })
            .catch(() => undefined);
        }
      }
    }
    return;
  }

  if (interaction.isAutocomplete()) {
    const command = commandsByName.get(interaction.commandName);
    if (command?.autocomplete === undefined) {
      return;
    }
    try {
      const access = evaluateAccess(interaction, botConfig);
      if (!access.allowed) {
        await interaction.respond([]);
        return;
      }
      await command.autocomplete(interaction, context);
    } catch (error) {
      console.error(`Autocomplete for /${interaction.commandName} failed:`, error);
      if (!interaction.responded) {
        await interaction.respond([]).catch(() => undefined);
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  const command = commandsByName.get(interaction.commandName);
  if (command === undefined) {
    return;
  }

  const access = evaluateAccess(interaction, botConfig);
  if (!access.allowed) {
    await interaction.reply({ content: access.reason, flags: MessageFlags.Ephemeral });
    return;
  }

  try {
    await command.execute(interaction, context);
  } catch (error) {
    console.error(`Command /${interaction.commandName} failed:`, error);
    try {
      await replyWithError(interaction, error);
    } catch (replyError) {
      console.error('Failed to send error response:', replyError);
    }
  }
});

client.login(config.discordToken).catch((error: unknown) => {
  if (error instanceof Error && error.message.includes('disallowed intents')) {
    console.error(
      'Discord rejected the login because a privileged intent is not enabled.\n' +
        'Open https://discord.com/developers/applications -> your application -> Bot,\n' +
        'and enable "Message Content Intent" (required by /restock). Then start the bot again.'
    );
    process.exit(1);
  }
  throw error;
});
