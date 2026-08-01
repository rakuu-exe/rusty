/**
 * Discord gateway client.
 *
 * A gateway connection (rather than an HTTP interactions endpoint) is what
 * makes sub-poll-interval alerting possible and is why the worker has to be
 * always-on: Supabase Edge Functions cap out at 150-400s and drop WebSockets,
 * so neither this nor the Rust+ socket can live there.
 */

import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  type Interaction,
  type TextChannel,
} from 'discord.js';
import type { DetectedEvent } from '../events/types.js';
import { eventColor, eventEmoji, formatEventLine } from '../format/message.js';
import { logger } from '../logger.js';
import { PAIRING_BUTTON_ID, PAIRING_MODAL_ID, handleCommand, handlePairingButton, handlePairingModal } from './commands.js';
import type { BotContext } from './context.js';

export interface DiscordBotOptions {
  token: string;
  guildId: string;
  timezone: string;
}

export class DiscordBot {
  private readonly client: Client;
  private context: BotContext | null = null;

  constructor(private readonly options: DiscordBotOptions) {
    // Only the guild scope is needed. MessageContent is deliberately absent:
    // the bot never reads Discord message bodies, so requesting it would be an
    // unnecessary privileged intent.
    this.client = new Client({ intents: [GatewayIntentBits.Guilds] });
  }

  /** Wire up the command context. Must be called before login. */
  setContext(context: BotContext): void {
    this.context = context;
  }

  async login(): Promise<void> {
    this.client.on(Events.InteractionCreate, (interaction) => void this.dispatch(interaction));

    this.client.on(Events.Error, (error) => logger.error({ err: error.message }, 'Discord client error'));

    const ready = new Promise<void>((resolve) => {
      this.client.once(Events.ClientReady, (client) => {
        logger.info({ user: client.user.tag }, 'Discord connected');
        resolve();
      });
    });

    await this.client.login(this.options.token);
    await ready;
  }

  async destroy(): Promise<void> {
    await this.client.destroy();
  }

  private async dispatch(interaction: Interaction): Promise<void> {
    const context = this.context;
    if (!context) {
      logger.error('interaction received before context was set');
      return;
    }

    try {
      if (interaction.isChatInputCommand()) {
        await handleCommand(interaction, context);
      } else if (interaction.isButton() && interaction.customId === PAIRING_BUTTON_ID) {
        await handlePairingButton(interaction);
      } else if (interaction.isModalSubmit() && interaction.customId === PAIRING_MODAL_ID) {
        await handlePairingModal(interaction, context);
      }
    } catch (error) {
      logger.error({ err: error instanceof Error ? error.message : String(error) }, 'interaction handler failed');

      // Best-effort apology; the interaction may already be acknowledged or
      // expired, in which case there is nothing useful left to do.
      if (interaction.isRepliable()) {
        const payload = { content: '❌ Something went wrong handling that.', ephemeral: true as const };
        try {
          if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
          else await interaction.reply(payload);
        } catch {
          /* interaction token expired */
        }
      }
    }
  }

  private async resolveChannel(channelId: string): Promise<TextChannel | null> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel?.isTextBased() && 'send' in channel) return channel as TextChannel;
      logger.warn({ channelId }, 'configured channel is not a text channel');
      return null;
    } catch (error) {
      logger.warn({ channelId, err: error instanceof Error ? error.message : String(error) }, 'could not fetch channel');
      return null;
    }
  }

  /** Post an event alert. `useEmbeds` false falls back to the plain headline. */
  async postEvent(channelId: string, event: DetectedEvent, useEmbeds: boolean): Promise<void> {
    const channel = await this.resolveChannel(channelId);
    if (!channel) return;

    const line = formatEventLine(event, { timezone: this.options.timezone });

    if (!useEmbeds) {
      await channel.send(`\`${line}\``);
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(eventColor(event))
      .setDescription(`${eventEmoji(event)} **${line}**`)
      .setTimestamp(event.at);

    await channel.send({ embeds: [embed] });
  }

  /** Plain text into a channel, used for status notices and chat mirroring. */
  async postText(channelId: string, content: string): Promise<void> {
    const channel = await this.resolveChannel(channelId);
    if (!channel) return;
    await channel.send(content);
  }
}
