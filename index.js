require("dotenv").config();
const sodium = require("libsodium-wrappers");
const { Client, GatewayIntentBits } = require("discord.js");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, EndBehaviorType, VoiceConnectionStatus, entersState, getVoiceConnection } = require("@discordjs/voice");
const OpusScript = require("opusscript");
const OpenAI = require("openai");
const { ElevenLabsClient } = require("@elevenlabs/elevenlabs-js");
const { execSync } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");

const DASHBOARD_API_URL = process.env.DASHBOARD_API_URL;
const DASHBOARD_API_KEY = process.env.DASHBOARD_API_KEY;
const SILENCE_TIMEOUT_MS = parseInt(process.env.SILENCE_TIMEOUT_MS || "1500");
const MIN_AUDIO_MS = parseInt(process.env.MIN_AUDIO_MS || "300");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates],
});

let audioPlayer = createAudioPlayer();
let currentConnection = null;
let isBotSpeaking = false;
const userRecordings = {};
const startTime = Date.now();

async function dashFetch(entityPath, method = "GET", body = null) {
  if (!DASHBOARD_API_URL) return null;
  const url = `${DASHBOARD_API_URL}/entities/${entityPath}`;
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", "x-api-key": DASHBOARD_API_KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function log(level, event, message, extra = {}) {
  console.log(`[${level.toUpperCase()}] [${event}] ${message}`);
  try { await dashFetch("BotLog", "POST", { level, event, message, ...extra }); } catch (e) { console.error("Log failed:", e.message); }
}

async function setupBotRolePermissions(guild) {
  try {
    const botRole = guild.members.me?.roles.highest;
    if (!botRole) return;
    const requiredPerms = ["ViewChannel", "SendMessages", "ReadMessageHistory", "Connect", "Speak", "UseVoiceActivity", "MoveMembers", "DeafenMembers", "MuteMembers"];
    await botRole.setPermissions(requiredPerms);
    console.log(`[DEBUG] Bot role updated in ${guild.name}`);
  } catch (e) {
    console.error("[DEBUG] Role setup failed:", e.message);
  }
}

client.once("ready", () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  log("success", "bot_join", `Bot started: ${client.user.tag}`);
});

client.on("guildCreate", async (guild) => {
  console.log(`[DEBUG] Bot joined: ${guild.name}`);
  await setupBotRolePermissions(guild);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.content === "!join") {
    const channel = message.member?.voice.channel;
    if (!channel) {
      await message.reply("❌ Join a voice channel first!");
      return;
    }
    const botPerms = channel.guild.members.me?.permissionsIn(channel);
    if (!botPerms?.has("Connect") || !botPerms?.has("Speak")) {
      await message.reply(`❌ Missing Connect or Speak permission in ${channel.name}`);
      return;
    }
    currentConnection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    try {
      await entersState(currentConnection, VoiceConnectionStatus.Ready, 30_000);
      currentConnection.subscribe(audioPlayer);
      await message.reply(`✅ Joined ${channel.name}! Listening...`);
      await log("success", "bot_join", `Joined ${channel.name}`, { channel: channel.name, guild_id: channel.guild.id });
    } catch (err) {
      console.error("[DEBUG] Connection failed:", err.message);
      currentConnection.destroy();
      await message.reply(`❌ Failed to connect: ${err.message}`);
    }
  }
  if (message.content === "!leave") {
    const conn = getVoiceConnection(message.guild.id);
    if (conn) {
      conn.destroy();
      currentConnection = null;
      await message.reply("👋 Left voice channel");
    }
  }
});

// Wait for libsodium to be ready, then start bot
async function startBot() {
  try {
    await sodium.ready;
    console.log("[DEBUG] libsodium ready ✅");
    client.login(process.env.DISCORD_TOKEN);
  } catch (e) {
    console.error("[DEBUG] libsodium failed:", e.message);
    process.exit(1);
  }
}

startBot();