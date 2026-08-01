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
import { DEEP_SEA_OPEN_MS, DIRECTION_COMPASS, isDeepSeaDirection, parseDuration } from '../events/deepSea.js';
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
    .setName('deepsea')
    .setDescription('Anchor the Deep Sea cycle (it has no map marker, so it must be told)')
    .setDefaultMemberPermissions(ADMIN_ONLY)
    .addStringOption((option) =>
      option
        .setName('closes_in')
        .setDescription('Countdown shown in game, e.g. "2h6m". Leave empty if it just opened.')
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('direction')
        .setDescription('Which half of the map it covers. Fixed for the whole wipe.')
        .setRequired(false)
        .addChoices(
          { name: 'Top / North', value: 'TOP' },
          { name: 'Bottom / South', value: 'BOTTOM' },
          { name: 'Left / West', value: 'LEFT' },
          { name: 'Right / East', value: 'RIGHT' },
        ),
    )
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
    case 'deepsea':
      return handleDeepSeaAnchor(interaction, context);
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

async function handleDeepSeaAnchor(
  interaction: ChatInputCommandInteraction,
  context: BotContext,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const raw = interaction.options.getString('closes_in', false);

  /**
   * Prefer the in-game countdown over "it just opened".
   *
   * Anchoring on the open moment requires catching it exactly; being a few
   * minutes late poisons every prediction afterwards with no way for the bot
   * to detect the error. The countdown is displayed in game and can be read
   * off at any point during the open window.
   */
  let closesInMs: number | null = null;
  if (raw !== null) {
    closesInMs = parseDuration(raw);
    if (closesInMs === null) {
      await interaction.editReply(
        `❌ Could not read "${raw}" as a duration. Try \`2h6m\`, \`90m\` or \`45s\`.`,
      );
      return;
    }
    if (closesInMs > DEEP_SEA_OPEN_MS) {
      await interaction.editReply(
        `❌ ${formatDuration(closesInMs)} is longer than the whole open window (${formatDuration(DEEP_SEA_OPEN_MS)}). ` +
          'If your server uses non-default `deepsea.wipeduration`, the cycle length needs changing in code.',
      );
      return;
    }
  }

  // Omitting the direction keeps whatever was set before, since it does not
  // change until the next wipe.
  const rawDirection = interaction.options.getString('direction', false);
  const direction = rawDirection && isDeepSeaDirection(rawDirection) ? rawDirection : null;

  try {
    const results = await context.recordDeepSeaOpened(closesInMs, direction);
    if (results.length === 0) {
      await interaction.editReply('❌ No connected server to anchor.');
      return;
    }

    const lines = results.map((r) => {
      const where = r.direction ? ` @ ${r.direction} (${DIRECTION_COMPASS[r.direction as keyof typeof DIRECTION_COMPASS]})` : '';
      return `✅ **${r.server}** — Deep Sea${where} closes in ~${formatDuration(r.closesInMs)}`;
    });
    lines.push(
      '',
      raw === null
        ? '⚠️ Anchored as opening *right now*. If it opened earlier, re-run with the countdown from the in-game map for an accurate cycle.'
        : 'Anchored from the in-game countdown. Check with `!deepsea` in team chat.',
    );
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
