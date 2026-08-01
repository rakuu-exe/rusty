/**
 * Slash command definitions and handlers.
 *
 * `/connect` is the interesting one. It cannot do the linking itself: the Rust+
 * API only exposes an already-paired player's team chat, so the bot has no way
 * to hear anything in game until pairing has already happened. What it does is
 * take the FCM credentials, start the push listener, and tell the user to hit
 * "Pair with Server" in game -- that push is what actually creates the link.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { formatClock, formatDuration } from '../format/message.js';
import { logger } from '../logger.js';
import type { BotContext } from './context.js';

export const PAIRING_MODAL_ID = 'rust-pairing-credentials';
export const PAIRING_INPUT_ID = 'credentials-json';
export const PAIRING_BUTTON_ID = 'rust-pairing-submit';

/**
 * Commands that change what the bot is connected to, or expose credentials.
 *
 * Restricted to Manage Server, so ordinary members cannot unpair the server,
 * redirect alerts, or start a pairing flow. Discord enforces this itself and
 * hides the commands from anyone without the permission, which is stronger
 * than checking inside the handler.
 */
const ADMIN_ONLY = PermissionFlagsBits.ManageGuild;

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('connect')
    .setDescription('Link the bot to a Rust server via Rust+ pairing')
    .setDefaultMemberPermissions(ADMIN_ONLY)
    .toJSON(),

  // Read-only, so everyone can check whether the bot is alive.
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show Rust+ connection status and pending event timers')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('disconnect')
    .setDescription('Stop tracking a paired Rust server')
    .setDefaultMemberPermissions(ADMIN_ONLY)
    .addStringOption((option) =>
      option.setName('server').setDescription('Server id (see /status)').setRequired(true),
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName('deepsea-opened')
    .setDescription('Record that the Deep Sea zone just opened (it has no map marker to detect)')
    .setDefaultMemberPermissions(ADMIN_ONLY)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Choose which channels the bot posts to')
    .setDefaultMemberPermissions(ADMIN_ONLY)
    .addChannelOption((option) =>
      option
        .setName('events')
        .setDescription('Channel for event alerts')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    )
    .addChannelOption((option) =>
      option
        .setName('team_chat')
        .setDescription('Channel mirroring in-game team chat (optional)')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false),
    )
    .toJSON(),
];

/** The instructions shown by /connect. Order matters and is explained inline. */
function pairingInstructions(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('Link a Rust server')
    .setColor(0xe67e22)
    .setDescription(
      [
        'Linking has to start here rather than in game: the Rust+ API only lets the bot',
        'read the team chat of a player it is **already** paired with.',
        '',
        '**1.** On the machine running the bot:',
        '```',
        'npm run fcm-register',
        '```',
        'Chrome opens; log in with Steam. This writes `rustplus.config.json`.',
        '',
        '**2.** Press **Submit credentials** below and paste that whole file.',
        '',
        '**3.** In Rust: `Esc` → **Rust+** → **Pair with Server**.',
        '',
        'The pairing push arrives within a few seconds and the bot connects itself.',
        '',
        '⚠️ The Steam token behind step 1 expires after **14 days**. You will be warned before it does.',
      ].join('\n'),
    );
}

function pairingModal(): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId(PAIRING_INPUT_ID)
    .setLabel('Contents of rustplus.config.json')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('{ "fcm_credentials": { ... }, "expo_push_token": "..." }')
    .setRequired(true);

  return new ModalBuilder()
    .setCustomId(PAIRING_MODAL_ID)
    .setTitle('Rust+ credentials')
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

export async function handleCommand(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  switch (interaction.commandName) {
    case 'connect':
      return handleConnect(interaction);
    case 'status':
      return handleStatus(interaction, context);
    case 'disconnect':
      return handleDisconnect(interaction, context);
    case 'setup':
      return handleSetup(interaction, context);
    case 'deepsea-opened':
      return handleDeepSeaOpened(interaction, context);
    default:
      await interaction.reply({ content: `Unknown command: ${interaction.commandName}`, ephemeral: true });
  }
}

async function handleConnect(interaction: ChatInputCommandInteraction): Promise<void> {
  const submit = new ButtonBuilder()
    .setCustomId(PAIRING_BUTTON_ID)
    .setLabel('Submit credentials')
    .setStyle(ButtonStyle.Primary);

  // Ephemeral throughout: the button leads to pasting credentials that grant
  // control of the user's Rust+ account, which must not land in a public channel.
  await interaction.reply({
    embeds: [pairingInstructions()],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(submit)],
    ephemeral: true,
  });
}

/**
 * A modal must be the first response to an interaction, so it is opened from
 * the button rather than from the command that printed the instructions.
 */
export async function handlePairingButton(interaction: ButtonInteraction): Promise<void> {
  await interaction.showModal(pairingModal());
}

export async function handlePairingModal(
  interaction: ModalSubmitInteraction,
  context: BotContext,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const raw = interaction.fields.getTextInputValue(PAIRING_INPUT_ID);

  try {
    await context.beginPairing(raw);
    await interaction.editReply(
      [
        '✅ Credentials stored and the pairing listener is running.',
        '',
        'Now open Rust and go to `Esc` → **Rust+** → **Pair with Server**.',
        'The bot will connect on its own and post here when it does.',
      ].join('\n'),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ err: message }, 'pairing credentials rejected');
    await interaction.editReply(`❌ ${message}`);
  }
}

async function handleStatus(interaction: ChatInputCommandInteraction, context: BotContext): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const [servers, pairing] = await Promise.all([context.getServerStatuses(), context.getPairingStatus()]);

  const embed = new EmbedBuilder().setTitle('Rust+ status').setColor(servers.some((s) => s.connected) ? 0x2ecc71 : 0xe74c3c);

  if (servers.length === 0) {
    embed.setDescription('No servers paired yet. Run `/connect` to link one.');
  } else {
    for (const server of servers) {
      const lines = [
        `**${server.connected ? '🟢 Connected' : '🔴 Disconnected'}** · \`${server.address}\``,
        server.players !== undefined ? `Players: ${server.players}/${server.maxPlayers}` : null,
        server.mapSize ? `Map size: ${server.mapSize}` : null,
        server.wipeTime ? `Wiped: ${formatClock(new Date(server.wipeTime), context.timezone)}` : null,
        `Id: \`${server.id}\``,
      ].filter((line): line is string => line !== null);

      if (server.pendingTimers.length > 0) {
        const timers = server.pendingTimers
          .map((t) => `${t.kind} in ${formatDuration(new Date(t.expiresAt).getTime() - Date.now())}`)
          .join(', ');
        lines.push(`Pending: ${timers}`);
      }

      embed.addFields({ name: server.name, value: lines.join('\n') });
    }
  }

  const pairingLine = pairing.listening
    ? pairing.expiresAt
      ? `Listening for pairings. Steam token expires ${formatClock(new Date(pairing.expiresAt), context.timezone)} on ${new Date(pairing.expiresAt).toDateString()}${pairing.expiringSoon ? ' ⚠️ **renew soon**' : ''}`
      : 'Listening for pairings.'
    : 'Not listening — no FCM credentials stored. Run `/connect`.';

  embed.addFields({ name: 'Pairing', value: pairingLine });

  await interaction.editReply({ embeds: [embed] });
}

async function handleDisconnect(interaction: ChatInputCommandInteraction, context: BotContext): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const serverId = interaction.options.getString('server', true);
  try {
    await context.disconnectServer(serverId);
    await interaction.editReply(`✅ Stopped tracking \`${serverId}\`.`);
  } catch (error) {
    await interaction.editReply(`❌ ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleDeepSeaOpened(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const results = await context.recordDeepSeaOpened();
    if (results.length === 0) {
      await interaction.editReply('❌ No connected server to anchor.');
      return;
    }

    const lines = results.map(
      (r) => `✅ **${r.server}** — Deep Sea anchored as open now, closes in ~${formatDuration(r.closesInMs)}`,
    );
    lines.push('', 'Use `!deepsea` in team chat to check it from now on.');
    await interaction.editReply(lines.join('\n'));
  } catch (error) {
    await interaction.editReply(`❌ ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleSetup(interaction: ChatInputCommandInteraction, context: BotContext): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const eventChannel = interaction.options.getChannel('events', true);
  const teamChatChannel = interaction.options.getChannel('team_chat', false);

  await context.setEventChannel(eventChannel.id);
  await context.setTeamChatChannel(teamChatChannel?.id ?? null);

  await interaction.editReply(
    [
      `✅ Event alerts → <#${eventChannel.id}>`,
      teamChatChannel ? `✅ Team chat mirror → <#${teamChatChannel.id}>` : 'ℹ️ Team chat mirroring disabled.',
    ].join('\n'),
  );
}
