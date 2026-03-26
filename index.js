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

const guildConnections = new Map(); // Map<guildId, { connection, audioPlayer, isSpeaking, userState }>
const startTime = Date.now();

function getGuildState(guildId) {
  if (!guildConnections.has(guildId)) {
    guildConnections.set(guildId, {
      connection: null,
      audioPlayer: createAudioPlayer(),
      isSpeaking: false,
      isMuted: false,
      userState: {}
    });
  }
  return guildConnections.get(guildId);
}

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
    const requiredPerms = ["ViewChannel", "SendMessages", "ReadMessageHistory", "Connect", "Speak", "UseVoiceActivity"];
    // Also set deafen/mute for guild-level (not needed per-channel)
    if (botRole.permissions.has("Administrator")) return;
    await botRole.setPermissions(requiredPerms);
    console.log(`[DEBUG] Bot role updated in ${guild.name}`);
  } catch (e) {
    console.error("[DEBUG] Role setup failed:", e.message);
  }
}

client.once("ready", async () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  log("success", "bot_join", `Bot started: ${client.user.tag}`);
  
  try {
    const newCommands = [
      { name: "join", description: "Join your voice channel and start listening" },
      { name: "mute", description: "Mute the bot (stop listening)" },
      { name: "unmute", description: "Unmute the bot (resume listening)" },
      { name: "leave", description: "Leave the voice channel" }
    ];
    
    const existing = await client.application.commands.fetch();
    const toKeep = existing.filter(cmd => !newCommands.find(nc => nc.name === cmd.name));
    const final = [...toKeep.values(), ...newCommands];
    
    await client.application.commands.set(final);
    console.log("[DEBUG] Slash commands registered ✅");
  } catch (e) {
    console.error("[DEBUG] Failed to register slash commands:", e.message);
  }
  
  setInterval(() => {
    guildConnections.forEach((guildState) => {
      if (guildState.connection?.state?.status) {
        console.log(`[DEBUG] Guild connection alive: ${guildState.connection?.state?.status}`);
      }
    });
  }, 60000);
});

client.on("guildCreate", async (guild) => {
  console.log(`[DEBUG] Bot joined: ${guild.name}`);
  await setupBotRolePermissions(guild);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;

  const guildId = interaction.guildId;
  const channel = interaction.member?.voice.channel;

  if (interaction.commandName === "join") {
    if (!channel) {
      await interaction.reply({ content: "❌ Join a voice channel first!", ephemeral: true });
      return;
    }
    const botPerms = channel.guild.members.me?.permissionsIn(channel);
    if (!botPerms?.has("Connect") || !botPerms?.has("Speak")) {
      await interaction.reply({ content: `❌ Missing Connect or Speak permission in ${channel.name}`, ephemeral: true });
      return;
    }

    const guildState = getGuildState(guildId);
    if (guildState.connection) {
      await interaction.reply({ content: "⚠️ Bot already in a voice channel!", ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    let retries = 3;
    let connected = false;

    while (retries > 0 && !connected) {
      try {
        guildState.connection = joinVoiceChannel({
          channelId: channel.id,
          guildId: channel.guild.id,
          adapterCreator: channel.guild.voiceAdapterCreator,
          selfDeaf: false,
          selfMute: false,
        });

        const readyPromise = Promise.race([
          entersState(guildState.connection, VoiceConnectionStatus.Ready, 15_000),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Connection timeout")), 16_000))
        ]);

        await readyPromise;
        guildState.connection.subscribe(guildState.audioPlayer);
        connected = true;

        await interaction.editReply(`✅ Joined ${channel.name}! Listening...`);
        await log("success", "bot_join", `Joined ${channel.name}`, { channel: channel.name, guild_id: guildId });
        startListening(guildState, channel);

      } catch (err) {
        retries--;
        try { guildState.connection?.destroy(); } catch {}
        guildState.connection = null;

        if (retries === 0) {
          await interaction.editReply(`❌ Cannot connect to voice. Check UDP/firewall.`);
          await log("error", "error", `Failed to join`, { guild_id: guildId });
        } else {
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }
    }
  }

  if (interaction.commandName === "mute") {
    const guildState = getGuildState(guildId);
    if (!guildState.connection) {
      await interaction.reply({ content: "❌ Bot not in voice", ephemeral: true });
      return;
    }
    guildState.isMuted = true;
    await interaction.reply({ content: "🔇 Bot muted", ephemeral: true });
  }

  if (interaction.commandName === "unmute") {
    const guildState = getGuildState(guildId);
    if (!guildState.connection) {
      await interaction.reply({ content: "❌ Bot not in voice", ephemeral: true });
      return;
    }
    guildState.isMuted = false;
    await interaction.reply({ content: "🔊 Bot unmuted", ephemeral: true });
  }

  if (interaction.commandName === "leave") {
    const guildState = getGuildState(guildId);
    if (guildState.connection) {
      guildState.connection.destroy();
      guildState.connection = null;
      guildState.userState = {};
      guildState.isMuted = false;
      await interaction.reply({ content: "👋 Left voice", ephemeral: true });
    } else {
      await interaction.reply({ content: "❌ Not in voice", ephemeral: true });
    }
  }
});

// Start listening for voice from guild members
function startListening(guildState, channel) {
  const receiver = guildState.connection.receiver;
  const userState = guildState.userState;

  function flushAndProcess(userId) {
    const state = userState[userId];
    if (!state?.hasAudio || !state.opusChunks.length) return;

    const { opusChunks, utteranceStart, username } = state;
    const duration = Date.now() - utteranceStart;

    state.opusChunks = [];
    state.hasAudio = false;
    state.utteranceStart = null;

    if (duration < 300) return;
    log("info", "speaking_end", `${username} stopped`, { username, user_id: userId });
    processAudio(guildState, opusChunks, userId, username, channel.name, utteranceStart);
  }

  function subscribeUser(userId) {
    if (userState[userId]) return;
    const user = client.users.cache.get(userId);
    const username = user?.username || userId;

    const opusStream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    userState[userId] = { stream: opusStream, opusChunks: [], silenceTimer: null, utteranceStart: null, hasAudio: false, username };

    opusStream.on("data", (packet) => {
      if (!packet?.length || guildState.isMuted) return;

      if (!userState[userId]?.hasAudio) {
        userState[userId].hasAudio = true;
        userState[userId].utteranceStart = Date.now();
        console.log(`[DEBUG] 🎙️ ${username} speaking`);
        log("info", "speaking_start", `${username} started`, { user_id: userId, username });
        if (guildState.isSpeaking) {
          guildState.audioPlayer.stop();
          guildState.isSpeaking = false;
        }
      }

      userState[userId].opusChunks.push(packet);
      if (userState[userId].silenceTimer) clearTimeout(userState[userId].silenceTimer);
      userState[userId].silenceTimer = setTimeout(() => flushAndProcess(userId), 1500);
    });

    opusStream.on("close", () => {
      if (userState[userId]?.silenceTimer) clearTimeout(userState[userId].silenceTimer);
      delete userState[userId];
    });
  }

  channel.members.filter(m => !m.user.bot).forEach(m => subscribeUser(m.id));

  client.on("voiceStateUpdate", (oldState, newState) => {
    if (newState.member?.user.bot) return;
    if (newState.channelId === channel.id && oldState.channelId !== channel.id) {
      subscribeUser(newState.id);
    } else if (oldState.channelId === channel.id && newState.channelId !== channel.id) {
      if (userState[oldState.id]?.silenceTimer) clearTimeout(userState[oldState.id].silenceTimer);
      delete userState[oldState.id];
    }
  });
}

async function processAudio(guildState, opusChunks, userId, username, channelName, startMs) {
  const rawPath = path.join("/tmp", `raw_${userId}_${Date.now()}.pcm`);
  const wavPath = path.join("/tmp", `audio_${userId}_${Date.now()}.wav`);
  const mp3Path = path.join("/tmp", `tts_${Date.now()}.mp3`);

  try {
    fs.writeFileSync(rawPath, Buffer.concat(opusChunks.map(p => Buffer.from(p))));
    execSync(`"${ffmpegPath}" -f s16le -ar 48000 -ac 2 -i "${rawPath}" -ar 16000 -ac 1 "${wavPath}" -y 2>/dev/null`, { stdio: "pipe" });
    fs.unlinkSync(rawPath);

    const transcription = await openai.audio.transcriptions.create({ file: fs.createReadStream(wavPath), model: "whisper-1" });
    const userText = transcription.text?.trim();
    if (!userText) return;
    log("success", "stt_output", `STT: ${userText}`, { username, user_id: userId });

    const gptRes = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{ role: "system", content: "Real-time voice assistant. Be concise." }, { role: "user", content: userText }]
    });
    const botReply = gptRes.choices[0].message.content?.trim();
    log("success", "gpt_response", `GPT: ${botReply}`, { username });

    const audioStream = await elevenlabs.textToSpeech.convert(process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM", {
      model_id: process.env.ELEVENLABS_MODEL || "eleven_turbo_v2_5",
      text: botReply,
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true }
    });

    await new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(mp3Path);
      audioStream.pipe(writeStream);
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });

    const resource = createAudioResource(mp3Path);
    guildState.isSpeaking = true;
    guildState.audioPlayer.play(resource);

    guildState.audioPlayer.once(AudioPlayerStatus.Idle, () => {
      guildState.isSpeaking = false;
      try { fs.unlinkSync(mp3Path); } catch {}
    });

    await dashFetch("Conversation", "POST", { user_id: userId, username, guild_id: guildId, channel: channelName, user_text: userText, bot_response: botReply, duration_ms: Date.now() - startMs });
  } catch (err) {
    log("error", "error", `Error: ${err.message}`, { username });
    console.error("[DEBUG]", err.message);
  } finally {
    try { fs.unlinkSync(rawPath); } catch {}
    try { fs.unlinkSync(wavPath); } catch {}
  }
}

// Check for pending announcements and read them aloud
async function checkAndReadAnnouncements(guildState) {
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
      if (guildState.isSpeaking) {
        guildState.audioPlayer.stop();
        guildState.isSpeaking = false;
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
        guildState.isSpeaking = true;
        guildState.audioPlayer.play(resource);
        await log("success", "announcement", `Announcement: ${ann.message}`);

        // Mark as sent
        await dashFetch(`Announcement/${ann.id}`, "PUT", { status: "sent", sent_at: new Date().toISOString() });

        guildState.audioPlayer.once(AudioPlayerStatus.Idle, () => {
          guildState.isSpeaking = false;
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
async function checkAndPlayLoopingMessages(guildState) {
  try {
    const looping = await dashFetch("ScheduledMessage?filter={\"enabled\":true}", "GET");
    if (!looping || looping.length === 0) return;

    for (const msg of looping) {
      const lastPlayed = msg.last_played ? new Date(msg.last_played).getTime() : 0;
      const intervalMs = msg.interval_minutes * 60 * 1000;
      const now = Date.now();

      if (now - lastPlayed < intervalMs) continue; // Not time yet

      // Play message
      if (guildState.isSpeaking) {
        guildState.audioPlayer.stop();
        guildState.isSpeaking = false;
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
        guildState.isSpeaking = true;
        guildState.audioPlayer.play(resource);

        guildState.audioPlayer.once(AudioPlayerStatus.Idle, () => {
          guildState.isSpeaking = false;
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

// Check announcements and looping messages every 30 seconds for all active guilds
setInterval(() => {
  guildConnections.forEach((guildState, guildId) => {
    if (guildState.connection) {
      checkAndReadAnnouncements(guildState);
      checkAndPlayLoopingMessages(guildState);
    }
  });
}, 30000);

startBot();