require("dotenv").config();
const sodium = require("libsodium-wrappers");
const { Client, GatewayIntentBits } = require("discord.js");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, EndBehaviorType, VoiceConnectionStatus, entersState } = require("@discordjs/voice");
const OpenAI = require("openai");
const { ElevenLabsClient } = require("@elevenlabs/elevenlabs-js");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");

const DASHBOARD_API_URL = process.env.DASHBOARD_API_URL;
const DASHBOARD_API_KEY = process.env.DASHBOARD_API_KEY;
const SILENCE_TIMEOUT_MS = parseInt(process.env.SILENCE_TIMEOUT_MS || "1500");
const MIN_AUDIO_MS = parseInt(process.env.MIN_AUDIO_MS || "300");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });

// ✅ FIX: Enable ALL required intents including GUILD_VOICE_STATES
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages,
  ],
});

const guildConnections = new Map();
const startTime = Date.now();

function getGuildState(guildId) {
  if (!guildConnections.has(guildId)) {
    guildConnections.set(guildId, {
      connection: null,
      audioPlayer: createAudioPlayer(),
      isSpeaking: false,
      isMuted: false,
      userState: {},
      guildId,
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
    if (!botRole) {
      console.log(`[DEBUG] Bot has no role in ${guild.name}`);
      return;
    }
    const requiredPerms = ["ViewChannel", "SendMessages", "ReadMessageHistory", "Connect", "Speak", "UseVoiceActivity"];
    if (botRole.permissions.has("Administrator")) {
      console.log(`[DEBUG] Bot has Admin in ${guild.name} — all perms OK`);
      return;
    }
    await botRole.setPermissions(requiredPerms);
    console.log(`[DEBUG] Bot role updated in ${guild.name}: ${requiredPerms.join(", ")}`);
  } catch (e) {
    console.error(`[DEBUG] Role setup failed: ${e.message}`);
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

    // ✅ FIX: Detailed permission diagnostics
    const botMember = channel.guild.members.me;
    const botPerms = botMember?.permissionsIn(channel);
    const guildPerms = botMember?.permissions;
    
    console.log(`[DEBUG] Guild: ${channel.guild.name} (${channel.guild.id})`);
    console.log(`[DEBUG] Channel: ${channel.name} (${channel.id})`);
    console.log(`[DEBUG] Guild perms: ${guildPerms?.toArray().join(", ") || "NONE"}`);
    console.log(`[DEBUG] Channel perms: ${botPerms?.toArray().join(", ") || "NONE"}`);
    console.log(`[DEBUG] Bot role: ${botMember?.roles.highest.name} (position: ${botMember?.roles.highest.position})`);

    if (!botPerms?.has("Connect")) {
      await interaction.reply({ content: `❌ Missing **Connect** permission in **${ channel.name}**`, ephemeral: true });
      return;
    }
    if (!botPerms?.has("Speak")) {
      await interaction.reply({ content: `❌ Missing **Speak** permission in **${ channel.name}**`, ephemeral: true });
      return;
    }

    const guildState = getGuildState(guildId);
    if (guildState.connection) {
      await interaction.reply({ content: "⚠️ Bot already in a voice channel!", ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      console.log(`[DEBUG] Connecting to voice channel: ${channel.name}`);
      guildState.connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });

      // Handle disconnects — auto-reconnect
      guildState.connection.on(VoiceConnectionStatus.Disconnected, async () => {
        console.log("[DEBUG] Disconnected — attempting reconnect...");
        try {
          await Promise.race([
            entersState(guildState.connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(guildState.connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
          // Seems to be reconnecting, wait for Ready
          await entersState(guildState.connection, VoiceConnectionStatus.Ready, 20_000);
          console.log("[DEBUG] Reconnected ✅");
        } catch {
          console.log("[DEBUG] Reconnect failed — destroying connection");
          guildState.connection.destroy();
          guildState.connection = null;
        }
      });

      // Don't wait for Ready — Discord voice on Railway often stays in
      // "signalling" due to UDP NAT traversal. Subscribe immediately and
      // start listening — the connection will become Ready once UDP is punched.
      guildState.connection.subscribe(guildState.audioPlayer);

      // Give it a moment then start listening regardless of state
      await new Promise(resolve => setTimeout(resolve, 2000));
      const state = guildState.connection.state.status;
      console.log(`[DEBUG] Connection state after 2s: ${state}`);

      await interaction.editReply(`✅ Joined ${channel.name}! (State: ${state}) — listening for voice...`);
      await log("success", "bot_join", `Joined ${channel.name} (state: ${state})`, { channel: channel.name, guild_id: guildId });
      startListening(guildState, channel);

    } catch (err) {
      console.error(`[DEBUG] Connection error: ${err.message}`);
      try { guildState.connection?.destroy(); } catch {}
      guildState.connection = null;
      await interaction.editReply(`❌ Failed to join voice: ${err.message}`);
      await log("error", "error", `Failed to join: ${err.message}`, { guild_id: guildId });
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

// ✅ Pipe raw Opus stream directly into ffmpeg — no native decoder needed
// Per Discord voice docs: audio is 48kHz 2ch Opus frames (960 samples = 20ms each)
const processingUsers = new Set();

function startListening(guildState, channel) {
  const receiver = guildState.connection.receiver;
  console.log(`[DEBUG] ✅ startListening: Opus→ffmpeg pipeline for ${channel.name}`);

  // Wait for Ready state before attaching speaking listener
  // On Railway, connection starts in signalling; UDP punch-through happens async
  const attachSpeaking = () => {
    const status = guildState.connection?.state?.status;
    console.log(`[DEBUG] Connection status when attaching speaking listener: ${status}`);
    attachSpeakingListener(guildState, channel, receiver);
  };

  if (guildState.connection.state.status === VoiceConnectionStatus.Ready) {
    attachSpeaking();
  } else {
    entersState(guildState.connection, VoiceConnectionStatus.Ready, 60_000)
      .then(() => {
        console.log("[DEBUG] Connection became Ready — attaching speaking listener");
        attachSpeaking();
      })
      .catch((err) => {
        console.error(`[DEBUG] Connection never became Ready: ${err.message}`);
        // Attach anyway — some partial voice data may still flow
        attachSpeaking();
      });
  }
}

function attachSpeakingListener(guildState, channel, receiver) {
  receiver.speaking.on("start", (userId) => {
    if (guildState.isMuted) return;
    if (processingUsers.has(userId)) return;

    const user = client.users.cache.get(userId);
    const username = user?.username || userId;
    console.log(`[DEBUG] 🎙️ ${username} started speaking`);
    log("info", "speaking_start", `${username} started speaking`, { user_id: userId, username });

    if (guildState.isSpeaking) {
      guildState.audioPlayer.stop();
      guildState.isSpeaking = false;
      log("warning", "interrupt", `Bot interrupted by ${username}`);
    }

    const utteranceStart = Date.now();
    processingUsers.add(userId);

    // Subscribe to Opus stream — closes automatically after silence
    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_TIMEOUT_MS },
    });

    const wavPath = path.join("/tmp", `audio_${userId}_${Date.now()}.wav`);

    // Pipe raw Opus packets directly into ffmpeg:
    // Discord sends containerless Opus frames per the voice docs.
    // ffmpeg with -f opus reads them correctly and converts to 16kHz mono WAV for Whisper.
    const ffmpeg = spawn(ffmpegPath, [
      "-f", "opus",          // Input format: raw Opus frames (as Discord sends per voice spec)
      "-i", "pipe:0",        // Read from stdin
      "-ar", "16000",        // Output: 16kHz (Whisper requirement)
      "-ac", "1",            // Output: mono
      "-f", "wav",           // Output: WAV container
      wavPath,
      "-y"
    ]);

    opusStream.pipe(ffmpeg.stdin);

    opusStream.on("error", (err) => {
      console.error(`[DEBUG] Opus stream error for ${username}: ${err.message}`);
    });

    ffmpeg.stderr.on("data", (d) => {
      // ffmpeg logs to stderr — only log if looks like an error
      const msg = d.toString();
      if (msg.includes("Error") || msg.includes("Invalid")) {
        console.error(`[FFMPEG ERR] ${msg.trim()}`);
      }
    });

    ffmpeg.on("close", async (code) => {
      processingUsers.delete(userId);
      const duration = Date.now() - utteranceStart;
      console.log(`[DEBUG] ${username} done — ffmpeg exited ${code}, ${duration}ms`);
      log("info", "speaking_end", `${username} stopped speaking`, { username, user_id: userId, duration_ms: duration });

      if (code !== 0 || duration < MIN_AUDIO_MS) {
        console.log(`[DEBUG] Skipping: ffmpeg code=${code}, duration=${duration}ms`);
        try { fs.unlinkSync(wavPath); } catch {}
        return;
      }

      await processAudio(guildState, wavPath, userId, username, channel.name, utteranceStart);
    });
  });

  console.log(`[DEBUG] receiver.speaking listener attached ✅`);
  
  // Re-attach if connection drops and reconnects
  guildState.connection.on(VoiceConnectionStatus.Ready, () => {
    console.log("[DEBUG] Connection re-entered Ready — speaking listener already active");
  });
}

async function processAudio(guildState, wavPath, userId, username, channelName, startMs) {
  // wavPath is already a 16kHz mono WAV file ready for Whisper (converted by ffmpeg in startListening)
  const mp3Path = path.join("/tmp", `tts_${Date.now()}.mp3`);

  try {
    console.log(`[DEBUG] Transcribing WAV with Whisper: ${wavPath}`);
    const transcription = await openai.audio.transcriptions.create({ 
      file: fs.createReadStream(wavPath), 
      model: process.env.STT_MODEL || "whisper-1"
    });
    const userText = transcription.text?.trim();
    if (!userText) {
      console.log("[DEBUG] Whisper returned empty/silent result, skipping");
      return;
    }
    console.log(`[DEBUG] STT: "${userText}"`);

    log("success", "stt_output", `STT: ${userText}`, { username, user_id: userId });

    // Get GPT response
    const gptRes = await openai.chat.completions.create({
      model: process.env.GPT_MODEL || "gpt-4-mini",
      messages: [
        { role: "system", content: process.env.SYSTEM_PROMPT || "You are a real-time voice assistant. Be concise and friendly." },
        { role: "user", content: userText }
      ],
      max_tokens: 150
    });
    const botReply = gptRes.choices[0].message.content?.trim();
    if (!botReply) return;
    log("success", "gpt_response", `GPT: ${botReply}`, { username });

    // Generate TTS
    const audioStream = await elevenlabs.textToSpeech.convert(process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM", {
      model_id: process.env.ELEVENLABS_MODEL || "eleven_turbo_v2_5",
      text: botReply,
      voice_settings: {
        stability: parseFloat(process.env.ELEVENLABS_STABILITY || "0.5"),
        similarity_boost: parseFloat(process.env.ELEVENLABS_SIMILARITY || "0.75"),
        style: parseFloat(process.env.ELEVENLABS_STYLE || "0.0"),
        use_speaker_boost: true
      }
    });

    await new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(mp3Path);
      audioStream.pipe(writeStream);
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });

    // Play audio
    const resource = createAudioResource(mp3Path);
    guildState.isSpeaking = true;
    guildState.audioPlayer.play(resource);
    log("info", "playback_start", `Playing response to ${username}`);

    guildState.audioPlayer.once(AudioPlayerStatus.Idle, () => {
      guildState.isSpeaking = false;
      try { fs.unlinkSync(mp3Path); } catch {}
      log("info", "playback_end", "Playback finished");
    });

    // Save conversation
    const duration = Date.now() - startMs;
    await dashFetch("Conversation", "POST", { 
      user_id: userId, 
      username, 
      guild_id: guildState.guildId, 
      channel: channelName, 
      user_text: userText, 
      bot_response: botReply, 
      duration_ms: duration 
    });

  } catch (err) {
    log("error", "error", `Process audio failed: ${err.message}`, { username });
    console.error("[DEBUG]", err.message);
  } finally {
    try { fs.unlinkSync(wavPath); } catch {}
    try { fs.unlinkSync(mp3Path); } catch {}
  }
}

async function checkAndReadAnnouncements(guildState) {
  try {
    const announcements = await dashFetch("Announcement?filter={\"status\":\"pending\"}&sort=scheduled_time&limit=10", "GET");
    if (!announcements || announcements.length === 0) return;

    for (const ann of announcements) {
      if (ann.scheduled_time) {
        const scheduledTime = new Date(ann.scheduled_time).getTime();
        const now = Date.now();
        if (now < scheduledTime) continue;
      }

      if (guildState.isSpeaking) {
        guildState.audioPlayer.stop();
        guildState.isSpeaking = false;
        await log("warning", "interrupt", "Bot interrupted for announcement");
      }

      try {
        const mp3Path = path.join("/tmp", `announcement_${Date.now()}.mp3`);
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

        const resource = createAudioResource(mp3Path);
        guildState.isSpeaking = true;
        guildState.audioPlayer.play(resource);
        await log("success", "announcement", `Announcement: ${ann.message}`);

        await dashFetch(`Announcement/${ann.id}`, "PUT", { status: "sent", sent_at: new Date().toISOString() });

        guildState.audioPlayer.once(AudioPlayerStatus.Idle, () => {
          guildState.isSpeaking = false;
          try { fs.unlinkSync(mp3Path); } catch {}
        });

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

async function checkAndPlayLoopingMessages(guildState) {
  try {
    const looping = await dashFetch("ScheduledMessage?filter={\"enabled\":true}", "GET");
    if (!looping || looping.length === 0) return;

    for (const msg of looping) {
      const lastPlayed = msg.last_played ? new Date(msg.last_played).getTime() : 0;
      const intervalMs = msg.interval_minutes * 60 * 1000;
      const now = Date.now();

      if (now - lastPlayed < intervalMs) continue;

      if (guildState.isSpeaking) {
        guildState.audioPlayer.stop();
        guildState.isSpeaking = false;
      }

      try {
        const mp3Path = path.join("/tmp", `loop_${Date.now()}.mp3`);
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

        await dashFetch(`ScheduledMessage/${msg.id}`, "PUT", { last_played: new Date().toISOString() });
      } catch (e) {
        console.error("[DEBUG] Looping message TTS failed:", e.message);
      }
    }
  } catch (e) {
    console.error("[DEBUG] Looping messages check failed:", e.message);
  }
}

setInterval(() => {
  guildConnections.forEach((guildState, guildId) => {
    if (guildState.connection) {
      checkAndReadAnnouncements(guildState);
      checkAndPlayLoopingMessages(guildState);
    }
  });
}, 30000);

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

// Fly.io requires a process to bind to PORT — add a minimal HTTP health server
const http = require("http");
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("OK");
}).listen(PORT, "0.0.0.0", () => {
  console.log(`[DEBUG] Health server listening on 0.0.0.0:${PORT}`);
});