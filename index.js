// ============================================
// Discord AI Voice Bot - index.js
// Uses: OpenAI Whisper (STT) + GPT (chat) + ElevenLabs (TTS)
// Run: node index.js
// ============================================
require("dotenv").config();
// libsodium-wrappers must be loaded before @discordjs/voice for encryption to work
const sodium = require("libsodium-wrappers");
sodium.ready.then(() => console.log("[DEBUG] libsodium ready ✅")).catch(e => console.error("[DEBUG] libsodium failed:", e));
const { Client, GatewayIntentBits } = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
} = require("@discordjs/voice");
const OpusScript = require("opusscript");
const OpenAI = require("openai");
const { ElevenLabsClient } = require("@elevenlabs/elevenlabs-js");
const { execSync } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");

// ---- CONFIG ----
const DASHBOARD_API_URL = process.env.DASHBOARD_API_URL; // e.g. https://api.base44.app/api/apps/YOUR_APP_ID
const DASHBOARD_API_KEY = process.env.DASHBOARD_API_KEY;
const SILENCE_TIMEOUT_MS = parseInt(process.env.SILENCE_TIMEOUT_MS || "1500");
const MIN_AUDIO_MS = parseInt(process.env.MIN_AUDIO_MS || "300");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
const ELEVENLABS_MODEL = process.env.ELEVENLABS_MODEL || "eleven_turbo_v2_5";
const ELEVENLABS_STABILITY = parseFloat(process.env.ELEVENLABS_STABILITY || "0.5");
const ELEVENLABS_SIMILARITY = parseFloat(process.env.ELEVENLABS_SIMILARITY || "0.75");
const ELEVENLABS_STYLE = parseFloat(process.env.ELEVENLABS_STYLE || "0.0");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

let audioPlayer = createAudioPlayer();
let currentConnection = null;
let isBotSpeaking = false;
const userRecordings = {};
const startTime = Date.now();

// ---- DASHBOARD HELPERS ----
// DASHBOARD_API_URL format: https://api.base44.app/api/apps/YOUR_APP_ID
//   (no trailing slash — the app ID is in your Base44 app's browser URL)
// DASHBOARD_API_KEY: your Base44 API key from Settings → API Key in the builder.

async function dashFetch(entityPath, method = "GET", body = null) {
  if (!DASHBOARD_API_URL) return null;
  const url = `${DASHBOARD_API_URL}/entities/${entityPath}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": DASHBOARD_API_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function log(level, event, message, extra = {}) {
  console.log(`[${level.toUpperCase()}] [${event}] ${message}`);
  try {
    await dashFetch("BotLog", "POST", { level, event, message, ...extra });
  } catch (e) { console.error("Dashboard log failed:", e.message); }
}

async function saveConversation(data) {
  try {
    await dashFetch("Conversation", "POST", data);
  } catch (e) { console.error("Save conversation failed:", e.message); }
}

async function updateStatus(data) {
  try {
    const list = await dashFetch("BotStatus?sort=-created_date&limit=1", "GET");
    const payload = { ...data, last_heartbeat: new Date().toISOString(), uptime_seconds: Math.floor((Date.now() - startTime) / 1000) };
    if (list && list.length > 0) {
      await dashFetch(`BotStatus/${list[0].id}`, "PUT", payload);
    } else {
      await dashFetch("BotStatus", "POST", payload);
    }
  } catch (e) { console.error("Update status failed:", e.message); }
}

// ---- AUTO-SETUP BOT ROLE PERMISSIONS ----
async function setupBotRolePermissions(guild) {
  try {
    const botRole = guild.members.me?.roles.highest;
    if (!botRole) { console.log("[DEBUG] Bot has no role in guild"); return; }

    const requiredPerms = [
      "ViewChannel",
      "SendMessages",
      "ReadMessageHistory",
      "Connect",
      "Speak",
      "UseVoiceActivity",
      "MoveMembers",
      "DeafenMembers",
      "MuteMembers"
    ];

    await botRole.setPermissions(requiredPerms);
    const actualPerms = botRole.permissions.toArray();
    console.log(`[DEBUG] Updated bot role in ${guild.name}. Permissions: ${actualPerms.join(", ")}`);
    await log("info", "bot_join", `Bot role permissions configured in ${guild.name} — has: ${actualPerms.join(", ")}`, { guild_id: guild.id });
  } catch (e) {
    console.error("[DEBUG] Failed to setup role permissions:", e.message);
    await log("error", "error", `Role setup failed: ${e.message}`, { guild_id: guild.id });
  }
}

// ---- BOT READY ----
client.once("ready", () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  log("success", "bot_join", `Bot started: ${client.user.tag}`);
  setInterval(() => {
    if (currentConnection) {
      updateStatus({ status: "online", uptime_seconds: Math.floor((Date.now() - startTime) / 1000) });
    }
  }, 30000);
});

// Auto-setup permissions when bot joins a guild
client.on("guildCreate", async (guild) => {
  console.log(`[DEBUG] Bot joined guild: ${guild.name}`);
  await setupBotRolePermissions(guild);
});

// ---- COMMANDS ----
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (message.content === "!join") {
    const channel = message.member?.voice.channel;
    if (!channel) {
      try { await message.reply("❌ Join a voice channel first!"); } catch (e) { console.error("Reply failed:", e.message); }
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
      // Wait for Ready BEFORE subscribing (30s timeout for slower networks)
      await entersState(currentConnection, VoiceConnectionStatus.Ready, 30_000);
      console.log("[DEBUG] Voice connection is Ready — subscribing player");
      currentConnection.subscribe(audioPlayer);
      try { await message.reply(`Joined **${channel.name}**! I'm listening...`); } catch (e) { console.error("Reply failed:", e.message); }
    } catch (err) {
      console.error("[DEBUG] Connection failed (check bot permissions in voice channel):", err.message);
      currentConnection.destroy();
      try { await message.reply("❌ Failed to connect — check bot has Connect + Speak + Read History permissions."); } catch (e) { console.error("Reply failed:", e.message); }
    }

    await log("success", "bot_join", `Joined ${channel.name}`, { channel: channel.name, guild_id: channel.guild.id });
    await updateStatus({ status: "online", guild_name: channel.guild.name, guild_id: channel.guild.id, channel: channel.name });
    startListening(currentConnection, channel);
  }

  if (message.content === "!leave") {
    const conn = getVoiceConnection(message.guild.id);
    if (conn) {
      conn.destroy();
      currentConnection = null;
      await log("info", "bot_leave", "Bot left voice channel");
      await updateStatus({ status: "offline" });
      try { await message.reply("👋 Left the voice channel."); } catch (e) { console.error("Reply failed:", e.message); }
    }
  }
});

// ---- VOICE LISTENING ----
// Strategy: use EndBehaviorType.Manual so the stream stays open permanently.
// We detect silence with a per-user timer. When the timer fires, we flush
// the collected packets and process them, then reset for the next utterance.
// This is the only reliable approach — AfterSilence closes immediately on
// silent users because Discord won't send RTP packets until the stream exists.
function startListening(connection, channel) {
  const receiver = connection.receiver;
  console.log(`[DEBUG] startListening for: ${channel.name}`);

  // userState[userId] = { stream, opusChunks, silenceTimer, utteranceStart, hasAudio, username }
  const userState = {};

  function flushAndProcess(userId) {
    const state = userState[userId];
    if (!state || !state.hasAudio || state.opusChunks.length === 0) return;

    const { opusChunks, utteranceStart, username } = state;
    const duration = Date.now() - utteranceStart;

    // Reset state for next utterance (keep stream open)
    state.opusChunks = [];
    state.hasAudio = false;
    state.utteranceStart = null;

    console.log(`[DEBUG] Flushing ${username}: ${opusChunks.length} chunks, ${duration}ms`);
    if (duration < MIN_AUDIO_MS) { console.log(`[DEBUG] Too short, skipping`); return; }

    log("info", "speaking_end", `${username} stopped speaking (${duration}ms)`, { username, user_id: userId });

    // Decode opus → 48kHz stereo PCM
    const decoder = new OpusScript(48000, 2, OpusScript.Application.VOIP);
    const pcmChunks = [];
    for (const pkt of opusChunks) {
      try {
        const decoded = decoder.decode(pkt);
        pcmChunks.push(Buffer.from(decoded.buffer));
      } catch (e) { console.error(`[DEBUG] decode error: ${e.message}`); }
    }
    decoder.delete();

    if (pcmChunks.length === 0) { console.log("[DEBUG] All decodes failed"); return; }

    const pcmBuffer = Buffer.concat(pcmChunks);
    console.log(`[DEBUG] PCM ready: ${pcmBuffer.length} bytes → Whisper`);
    processAudio(pcmBuffer, userId, username, channel.name, utteranceStart);
  }

  function subscribeUser(userId) {
    if (userState[userId]) return;

    const user = client.users.cache.get(userId);
    const username = user?.username || userId;
    console.log(`[DEBUG] Subscribing (Manual) to: ${username} (${userId})`);

    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });

    userState[userId] = {
      stream: opusStream,
      opusChunks: [],
      silenceTimer: null,
      utteranceStart: null,
      hasAudio: false,
      username,
    };

    // If we NEVER see this log after speaking, it's a permissions/encryption issue
    console.log(`[DEBUG] Stream open for ${username} — waiting for audio packets...`);

    opusStream.on("data", (packet) => {
      const state = userState[userId];
      if (!state) return;

      // First packet of a new utterance
      if (!state.hasAudio) {
        state.hasAudio = true;
        state.utteranceStart = Date.now();
        console.log(`[DEBUG] 🎙️ First packet from ${username} (size=${packet.length})`);
        log("info", "speaking_start", `${username} started speaking`, { user_id: userId, username, channel: channel.name });
        if (isBotSpeaking) {
          audioPlayer.stop();
          isBotSpeaking = false;
          log("warning", "interrupt", `Bot interrupted by ${username}`, { username });
        }
      }

      state.opusChunks.push(packet);

      // Reset silence timer on every packet
      if (state.silenceTimer) clearTimeout(state.silenceTimer);
      state.silenceTimer = setTimeout(() => {
        console.log(`[DEBUG] Silence detected for ${username} — flushing`);
        flushAndProcess(userId);
      }, SILENCE_TIMEOUT_MS);
    });

    opusStream.on("error", (err) => {
      console.error(`[DEBUG] stream error for ${username}: ${err.message}`);
      delete userState[userId];
    });

    opusStream.on("close", () => {
      // Stream was destroyed (user left, etc.) — clean up
      const state = userState[userId];
      if (state?.silenceTimer) clearTimeout(state.silenceTimer);
      delete userState[userId];
      console.log(`[DEBUG] Stream closed for ${username}`);
    });
  }

  function unsubscribeUser(userId) {
    const state = userState[userId];
    if (!state) return;
    if (state.silenceTimer) clearTimeout(state.silenceTimer);
    try { state.stream.destroy(); } catch {}
    delete userState[userId];
    console.log(`[DEBUG] Unsubscribed: ${state.username}`);
  }

  // Subscribe all current non-bot members immediately
  const initialMembers = channel.members.filter(m => !m.user.bot);
  initialMembers.forEach(m => {
    console.log(`[DEBUG] Pre-subscribing: ${m.user.username}`);
    subscribeUser(m.id);
  });
  console.log(`[DEBUG] Subscribed to ${initialMembers.size} users. Listening...`);

  // Handle members joining/leaving mid-session
  client.on("voiceStateUpdate", (oldState, newState) => {
    if (newState.member?.user.bot) return;
    const joinedChannel = newState.channelId === channel.id && oldState.channelId !== channel.id;
    const leftChannel = oldState.channelId === channel.id && newState.channelId !== channel.id;
    if (joinedChannel) {
      console.log(`[DEBUG] ${newState.member?.user.username} joined — subscribing`);
      subscribeUser(newState.id);
    } else if (leftChannel) {
      console.log(`[DEBUG] ${oldState.member?.user.username} left — unsubscribing`);
      unsubscribeUser(oldState.id);
    }
  });
}

// ---- PROCESS AUDIO ----
async function processAudio(pcmBuffer, userId, username, channelName, startMs) {
  console.log(`[DEBUG] processAudio called for ${username}, buffer=${pcmBuffer.length} bytes`);
  const rawPath = path.join("/tmp", `raw_${userId}_${Date.now()}.pcm`);
  const wavPath = path.join("/tmp", `audio_${userId}_${Date.now()}.wav`);
  const mp3Path = path.join("/tmp", `tts_${Date.now()}.mp3`);

  try {
    // Write raw 48kHz stereo s16le PCM, then convert to 16kHz mono WAV for Whisper
    fs.writeFileSync(rawPath, pcmBuffer);
    execSync(
      `"${ffmpegPath}" -f s16le -ar 48000 -ac 2 -i "${rawPath}" -ar 16000 -ac 1 "${wavPath}" -y`,
      { stdio: "pipe" }
    );
    fs.unlinkSync(rawPath);
    console.log(`[DEBUG] WAV written: ${wavPath}`);

    // --- STT via OpenAI Whisper ---
    log("info", "stt_output", "Sending to Whisper...", { username });
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(wavPath),
      model: process.env.STT_MODEL || "whisper-1",
    });
    const userText = transcription.text?.trim();
    if (!userText) { log("warning", "stt_output", "Empty transcription, skipping"); return; }
    log("success", "stt_output", `STT: "${userText}"`, { username, user_id: userId, message: userText });

    // --- GPT Chat ---
    log("info", "gpt_response", "Sending to GPT...", { username });
    const systemPrompt = process.env.SYSTEM_PROMPT || "You are a real-time voice assistant in a Discord call. Be concise and friendly.";
    const gptRes = await openai.chat.completions.create({
      model: process.env.GPT_MODEL || "gpt-4.1-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText },
      ],
    });
    const botReply = gptRes.choices[0].message.content?.trim();
    log("success", "gpt_response", `GPT: "${botReply}"`, { username, user_id: userId, message: botReply });

    // --- TTS via ElevenLabs ---
    log("info", "tts_done", `Generating ElevenLabs TTS (voice: ${ELEVENLABS_VOICE_ID})...`, { username });
    const audioStream = await elevenlabs.textToSpeech.convert(ELEVENLABS_VOICE_ID, {
      model_id: ELEVENLABS_MODEL,
      text: botReply,
      voice_settings: {
        stability: ELEVENLABS_STABILITY,
        similarity_boost: ELEVENLABS_SIMILARITY,
        style: ELEVENLABS_STYLE,
        use_speaker_boost: true,
      },
    });

    await new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(mp3Path);
      audioStream.pipe(writeStream);
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });
    log("success", "tts_done", "ElevenLabs TTS audio ready");

    // --- Playback ---
    const resource = createAudioResource(mp3Path);
    isBotSpeaking = true;
    audioPlayer.play(resource);
    log("info", "playback_start", "Playing ElevenLabs response...", { username });

    audioPlayer.once(AudioPlayerStatus.Idle, () => {
      isBotSpeaking = false;
      log("info", "playback_end", "Playback finished");
      try { fs.unlinkSync(mp3Path); } catch {}
    });

    const duration_ms = Date.now() - startMs;
    await saveConversation({ user_id: userId, username, guild_id: "N/A", channel: channelName, user_text: userText, bot_response: botReply, duration_ms });

  } catch (err) {
    log("error", "error", `Error: ${err.message}`, { username });
    console.error("[DEBUG] Full error:", err);
  } finally {
    try { fs.unlinkSync(rawPath); } catch {}
    try { fs.unlinkSync(wavPath); } catch {}
  }
}

client.login(process.env.DISCORD_TOKEN);