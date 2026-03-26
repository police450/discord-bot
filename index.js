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
    let retries = 3;
    let connected = false;

    while (retries > 0 && !connected) {
      try {
        console.log(`[DEBUG] Attempting connection (retry ${4 - retries}/3)...`);
        guildState.connection = joinVoiceChannel({
          channelId: channel.id,
          guildId: channel.guild.id,
          adapterCreator: channel.guild.voiceAdapterCreator,
          selfDeaf: false,
          selfMute: false,
        });

        const readyPromise = Promise.race([
          entersState(guildState.connection, VoiceConnectionStatus.Ready, 15_000),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Connection timeout after 15s")), 16_000))
        ]);

        await readyPromise;
        guildState.connection.subscribe(guildState.audioPlayer);
        connected = true;

        console.log(`[DEBUG] ✅ Voice connection established`);
        await interaction.editReply(`✅ Joined ${channel.name}! Listening...`);
        await log("success", "bot_join", `Joined ${channel.name}`, { channel: channel.name, guild_id: guildId });
        startListening(guildState, channel);

      } catch (err) {
        retries--;
        console.error(`[DEBUG] Connection error: ${err.message}`);
        try { guildState.connection?.destroy(); } catch {}
        guildState.connection = null;

        if (retries === 0) {
          await interaction.editReply(`❌ Cannot connect to voice after 3 attempts.
• Check bot has **Connect** & **Speak** perms
• Verify firewall allows UDP
• Ensure intents are enabled in Discord Dev Portal`);
          await log("error", "error", `Failed to join: ${err.message}`, { guild_id: guildId });
        } else {
          console.log(`[DEBUG] Retrying in 3 seconds...`);
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

// ✅ Rate limiting & caching for transcription
const transcriptionCache = new Map();
const rateLimiter = new Map();
const speakingUsers = new Map();

function isRateLimited(userId) {
  const lastCall = rateLimiter.get(userId) || 0;
  const now = Date.now();
  if (now - lastCall < 500) return true;
  rateLimiter.set(userId, now);
  return false;
}

function cacheKey(data) {
  return require("crypto").createHash("md5").update(JSON.stringify(data)).digest("hex");
}

function startListening(guildState, channel) {
  const receiver = guildState.connection.receiver;
  const userState = guildState.userState;
  console.log(`[DEBUG] startListening: Receiver ready for ${channel.name}`);

  function flushAndProcess(userId) {
    const state = userState[userId];
    if (!state?.hasAudio || !state.opusChunks.length) return;

    const { opusChunks, utteranceStart, username } = state;
    const duration = Date.now() - utteranceStart;

    state.opusChunks = [];
    state.hasAudio = false;
    state.utteranceStart = null;

    if (duration < MIN_AUDIO_MS) {
      console.log(`[DEBUG] Audio too short (${duration}ms < ${MIN_AUDIO_MS}ms), skipping`);
      return;
    }

    // ✅ Rate limiting check
    if (isRateLimited(userId)) {
      console.log(`[DEBUG] Rate limit: ${username} speaking too frequently, buffering next utterance`);
      return;
    }

    console.log(`[DEBUG] Flushing ${username}: ${opusChunks.length} packets, ${duration}ms`);
    log("info", "speaking_end", `${username} stopped speaking`, { username, user_id: userId, duration_ms: duration });
    
    // Track speaker stats
    const speakerData = speakingUsers.get(userId) || { username, totalSpeakTime: 0, utterances: 0 };
    speakerData.totalSpeakTime += duration;
    speakerData.utterances += 1;
    speakerData.lastSpoke = Date.now();
    speakingUsers.set(userId, speakerData);

    processAudio(guildState, opusChunks, userId, username, channel.name, utteranceStart);
  }

  function subscribeUser(userId) {
    if (userState[userId]) return;
    const user = client.users.cache.get(userId);
    const username = user?.username || userId;

    console.log(`[DEBUG] Subscribing to: ${username}`);
    const opusStream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    userState[userId] = { 
      stream: opusStream, 
      opusChunks: [], 
      silenceTimer: null, 
      utteranceStart: null, 
      hasAudio: false, 
      username,
      packetCount: 0 
    };

    opusStream.on("data", (packet) => {
      const state = userState[userId];
      if (!state) return;

      if (!packet || packet.length === 0) return;

      state.packetCount++;

      if (!state.hasAudio) {
        state.hasAudio = true;
        state.utteranceStart = Date.now();
        console.log(`[DEBUG] 🎙️ ${username} started speaking (packet ${state.packetCount})`);
        log("info", "speaking_start", `${username} started speaking`, { user_id: userId, username });
        if (guildState.isSpeaking) {
          guildState.audioPlayer.stop();
          guildState.isSpeaking = false;
        }
      }

      state.opusChunks.push(packet);
      if (state.silenceTimer) clearTimeout(state.silenceTimer);
      state.silenceTimer = setTimeout(() => flushAndProcess(userId), SILENCE_TIMEOUT_MS);
    });

    opusStream.on("error", (err) => {
      console.error(`[DEBUG] Stream error for ${username}: ${err.message}`);
      delete userState[userId];
    });

    opusStream.on("close", () => {
      const state = userState[userId];
      if (state?.silenceTimer) clearTimeout(state.silenceTimer);
      delete userState[userId];
      console.log(`[DEBUG] Stream closed for ${username} (${state?.packetCount || 0} packets received)`);
    });
  }

  // Subscribe all current non-bot members
  const initialMembers = channel.members.filter(m => !m.user.bot);
  console.log(`[DEBUG] Pre-subscribing ${initialMembers.size} members...`);
  initialMembers.forEach(m => {
    subscribeUser(m.id);
  });

  // Handle members joining/leaving
  client.on("voiceStateUpdate", (oldState, newState) => {
    if (newState.member?.user.bot) return;
    const joinedChannel = newState.channelId === channel.id && oldState.channelId !== channel.id;
    const leftChannel = oldState.channelId === channel.id && newState.channelId !== channel.id;
    if (joinedChannel) {
      console.log(`[DEBUG] ${newState.member?.user.username} joined`);
      subscribeUser(newState.id);
    } else if (leftChannel) {
      const userData = speakingUsers.get(oldState.id);
      if (userData) {
        console.log(`[DEBUG] ${userData.username} left (spoke ${userData.utterances}x, total ${userData.totalSpeakTime}ms)`);
      }
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
    // Write & decode audio
    const pcmBuffer = Buffer.concat(opusChunks.map(p => Buffer.from(p)));
    fs.writeFileSync(rawPath, pcmBuffer);
    console.log(`[DEBUG] Opus: ${opusChunks.length} packets (${pcmBuffer.length} bytes) → decoding`);
    
    execSync(`"${ffmpegPath}" -f s16le -ar 48000 -ac 2 -i "${rawPath}" -ar 16000 -ac 1 "${wavPath}" -y 2>/dev/null`, { stdio: "pipe" });
    fs.unlinkSync(rawPath);

    // Check cache for transcription
    const audioHash = cacheKey(pcmBuffer);
    let userText = transcriptionCache.get(audioHash);
    
    if (!userText) {
      console.log("[DEBUG] Transcribing with Whisper...");
      const transcription = await openai.audio.transcriptions.create({ 
        file: fs.createReadStream(wavPath), 
        model: "whisper-1" 
      });
      userText = transcription.text?.trim();
      if (!userText) {
        console.log("[DEBUG] Whisper returned empty result");
        return;
      }
      transcriptionCache.set(audioHash, userText);
      console.log(`[DEBUG] Cached: "${userText.substring(0, 50)}..."`);
    } else {
      console.log("[DEBUG] Cache hit!");
    }

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
    try { fs.unlinkSync(rawPath); } catch {}
    try { fs.unlinkSync(wavPath); } catch {}
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