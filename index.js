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

    // Retry logic for voice connection with stuck state detection
    let retries = 3;
    let connected = false;

    while (retries > 0 && !connected) {
      try {
        const attempt = 4 - retries;
        console.log(`[DEBUG] Attempting voice connection (attempt ${attempt}/3)...`);

        // Destroy previous connection if exists
        if (currentConnection) {
          try { currentConnection.destroy(); } catch {}
          currentConnection = null;
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for cleanup
        }

        currentConnection = joinVoiceChannel({
          channelId: channel.id,
          guildId: channel.guild.id,
          adapterCreator: channel.guild.voiceAdapterCreator,
          selfDeaf: false,
          selfMute: false,
        });

        // Detect stuck state (signalling loop)
        let signallingCount = 0;
        const connectionMonitor = (oldState, newState) => {
          console.log(`[DEBUG] Voice state: ${oldState.status} → ${newState.status}`);

          // Detect stuck signalling
          if (newState.status === "signalling") {
            signallingCount++;
            if (signallingCount > 2) {
              console.log("[DEBUG] Stuck in signalling loop — likely UDP connection issue");
              throw new Error("UDP connection failed (stuck in signalling)");
            }
          } else {
            signallingCount = 0;
          }

          // Handle disconnects and attempt recovery
          if (newState.status === VoiceConnectionStatus.Disconnected) {
            console.log("[DEBUG] Disconnected! Attempting recovery...");
            if (oldState.status !== VoiceConnectionStatus.Connecting) {
              try {
                Promise.race([
                  entersState(currentConnection, VoiceConnectionStatus.Signalling, 5_000),
                  entersState(currentConnection, VoiceConnectionStatus.Connected, 5_000),
                ]).catch(err => {
                  console.log("[DEBUG] Recovery failed:", err.message);
                  currentConnection?.destroy();
                  currentConnection = null;
                });
              } catch (e) {
                console.error("[DEBUG] Recovery error:", e.message);
              }
            }
          }
        };
        currentConnection.on("stateChange", connectionMonitor);

        // Wait for connection with extended timeout for network latency
        const readyPromise = Promise.race([
          entersState(currentConnection, VoiceConnectionStatus.Ready, 20_000),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Voice ready timeout — possible UDP block or network delay")), 21_000))
        ]);

        await readyPromise;
        console.log("[DEBUG] Voice connection established — subscribing player");
        currentConnection.subscribe(audioPlayer);
        connected = true;

        await message.reply(`✅ Joined ${channel.name}! Listening...`);
        await log("success", "bot_join", `Joined ${channel.name}`, { channel: channel.name, guild_id: channel.guild.id });

        // Start listening for voice
        startListening(currentConnection, channel);

        } catch (err) {
        const errorMsg = err.message || "Unknown error";
        console.error(`[DEBUG] Attempt ${4 - retries} failed: ${errorMsg}`);
        retries--;

        try { currentConnection?.destroy(); } catch {}
        currentConnection = null;

        if (retries > 0) {
          const waitTime = 5000;
          console.log(`[DEBUG] Retrying in 5 seconds... (${retries} attempts left)`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        } else {
          console.error("[DEBUG] Connection failed after 3 attempts");
          await message.reply(`❌ Cannot connect to voice: ${errorMsg}
→ Check: UDP firewall, bot perms, Discord intents`);
          await log("error", "error", `Failed to join ${channel.name}: ${errorMsg}`, { channel: channel.name, guild_id: channel.guild.id });
        }
      }
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

// Check for pending announcements and read them aloud
async function checkAndReadAnnouncements(connection) {
  try {
    const announcements = await dashFetch("Announcement?filter={\"status\":\"pending\"}&sort=scheduled_time&limit=10", "GET");
    if (!announcements || announcements.length === 0) return;

    for (const ann of announcements) {
      // If scheduled, check if it's time yet
      if (ann.scheduled_time) {
        const scheduledTime = new Date(ann.scheduled_time).getTime();
        const now = Date.now();
        if (now < scheduledTime) continue; // Not time yet, skip
      }

      // Interrupt if bot is speaking
      if (isBotSpeaking) {
        audioPlayer.stop();
        isBotSpeaking = false;
        await log("warning", "interrupt", "Bot interrupted for announcement");
      }

      try {
        // Generate TTS for announcement
        const mp3Path = path.join("/tmp", `announcement_${Date.now()}.mp3`);
        const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
        
        const audioStream = await elevenlabs.textToSpeech.convert(process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM", {
          model_id: process.env.ELEVENLABS_MODEL || "eleven_turbo_v2_5",
          text: `Announcement from the developers: ${ann.message}`,
          voice_settings: {
            stability: parseFloat(process.env.ELEVENLABS_STABILITY || "0.5"),
            similarity_boost: parseFloat(process.env.ELEVENLABS_SIMILARITY || "0.75"),
            style: parseFloat(process.env.ELEVENLABS_STYLE || "0.0"),
            use_speaker_boost: true,
          },
        });

        await new Promise((resolve, reject) => {
          const writeStream = fs.createWriteStream(mp3Path);
          audioStream.pipe(writeStream);
          writeStream.on("finish", resolve);
          writeStream.on("error", reject);
        });

        // Play announcement
        const resource = createAudioResource(mp3Path);
        isBotSpeaking = true;
        audioPlayer.play(resource);
        await log("success", "announcement", `Announcement: ${ann.message}`);

        // Mark as sent
        await dashFetch(`Announcement/${ann.id}`, "PUT", { status: "sent", sent_at: new Date().toISOString() });

        audioPlayer.once(AudioPlayerStatus.Idle, () => {
          isBotSpeaking = false;
          try { fs.unlinkSync(mp3Path); } catch {}
        });

        // Wait for announcement to finish before next one
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (e) {
        console.error("[DEBUG] Announcement TTS failed:", e.message);
        await dashFetch(`Announcement/${ann.id}`, "PUT", { status: "failed" });
      }
    }
  } catch (e) {
    console.error("[DEBUG] Announcement check failed:", e.message);
  }
}

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

// Check and play looping messages
async function checkAndPlayLoopingMessages(connection) {
  try {
    const looping = await dashFetch("ScheduledMessage?filter={\"enabled\":true}", "GET");
    if (!looping || looping.length === 0) return;

    for (const msg of looping) {
      const lastPlayed = msg.last_played ? new Date(msg.last_played).getTime() : 0;
      const intervalMs = msg.interval_minutes * 60 * 1000;
      const now = Date.now();

      if (now - lastPlayed < intervalMs) continue; // Not time yet

      // Play message
      if (isBotSpeaking) {
        audioPlayer.stop();
        isBotSpeaking = false;
      }

      try {
        const mp3Path = path.join("/tmp", `loop_${Date.now()}.mp3`);
        const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
        
        const audioStream = await elevenlabs.textToSpeech.convert(process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM", {
          model_id: process.env.ELEVENLABS_MODEL || "eleven_turbo_v2_5",
          text: msg.message,
          voice_settings: {
            stability: parseFloat(process.env.ELEVENLABS_STABILITY || "0.5"),
            similarity_boost: parseFloat(process.env.ELEVENLABS_SIMILARITY || "0.75"),
            style: parseFloat(process.env.ELEVENLABS_STYLE || "0.0"),
            use_speaker_boost: true,
          },
        });

        await new Promise((resolve, reject) => {
          const writeStream = fs.createWriteStream(mp3Path);
          audioStream.pipe(writeStream);
          writeStream.on("finish", resolve);
          writeStream.on("error", reject);
        });

        const resource = createAudioResource(mp3Path);
        isBotSpeaking = true;
        audioPlayer.play(resource);

        audioPlayer.once(AudioPlayerStatus.Idle, () => {
          isBotSpeaking = false;
          try { fs.unlinkSync(mp3Path); } catch {}
        });

        // Update last_played
        await dashFetch(`ScheduledMessage/${msg.id}`, "PUT", { last_played: new Date().toISOString() });
      } catch (e) {
        console.error("[DEBUG] Looping message TTS failed:", e.message);
      }
    }
  } catch (e) {
    console.error("[DEBUG] Looping messages check failed:", e.message);
  }
}

// Check announcements and looping messages every 30 seconds when bot is in a voice channel
setInterval(() => {
  if (currentConnection) {
    checkAndReadAnnouncements(currentConnection);
    checkAndPlayLoopingMessages(currentConnection);
  }
}, 30000);

startBot();