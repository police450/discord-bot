// Catch ALL unhandled errors at the very top — before any other code
process.on("unhandledRejection", (err) => {
  console.error("[DEBUG] Unhandled rejection (caught):", err?.message || err);
});
process.on("uncaughtException", (err) => {
  console.error("[DEBUG] Uncaught exception (caught):", err?.message || err);
});

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

// Lazy-init API clients so missing env vars don't crash at startup
let _openai = null;
let _elevenlabs = null;

function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

function getElevenLabs() {
  if (!_elevenlabs) _elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
  return _elevenlabs;
}

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

// Prevent any unhandled errors from crashing the process
client.on("error", (err) => {
  console.error("[DEBUG] Discord client error (caught):", err.message);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;

  const guildId = interaction.guildId;
  const channel = interaction.member?.voice.channel;

  // Helper: safe reply that won't crash if interaction expired
  const safeReply = async (content) => {
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(content);
      } else {
        await interaction.reply({ content, flags: 64 });
      }
    } catch (e) {
      console.error("[DEBUG] safeReply failed (interaction expired?):", e.message);
    }
  };

  try {
    if (interaction.commandName === "join") {
      if (!channel) {
        await safeReply("❌ Join a voice channel first!");
        return;
      }

      const botMember = channel.guild.members.me;
      const botPerms = botMember?.permissionsIn(channel);

      if (!botPerms?.has("Connect")) {
        await safeReply(`❌ Missing **Connect** permission in **${channel.name}**`);
        return;
      }
      if (!botPerms?.has("Speak")) {
        await safeReply(`❌ Missing **Speak** permission in **${channel.name}**`);
        return;
      }

      const guildState = getGuildState(guildId);
      if (guildState.connection) {
        await safeReply("⚠️ Bot already in a voice channel!");
        return;
      }

      // Wrap deferReply — if interaction already handled by another instance, skip
      let deferred = false;
      try {
        await interaction.deferReply({ flags: 64 });
        deferred = true;
      } catch (e) {
        console.error("[DEBUG] deferReply failed (likely duplicate instance):", e.message);
        return; // Another machine already handled this interaction
      }

      try {
        console.log(`[DEBUG] Connecting to voice channel: ${channel.name}`);
        // Get our public IPv4 — must be set via: flyctl secrets set FLY_PUBLIC_IP=<your-dedicated-v4>
        let publicIp = process.env.FLY_PUBLIC_IP || null;
        console.log(`[DEBUG] FLY_PUBLIC_IP env: ${publicIp || "NOT SET"}`);
        if (!publicIp) {
          try {
            const ipRes = await fetch("https://api.ipify.org?format=json");
            const ipData = await ipRes.json();
            publicIp = ipData.ip;
            console.log(`[DEBUG] Detected public IP via ipify: ${publicIp}`);
          } catch (e) {
            console.error("[DEBUG] Failed to get public IP via ipify:", e.message);
          }
        } else {
          console.log(`[DEBUG] Using FLY_PUBLIC_IP: ${publicIp}`);
        }

        guildState.connection = joinVoiceChannel({
          channelId: channel.id,
          guildId: channel.guild.id,
          adapterCreator: channel.guild.voiceAdapterCreator,
          selfDeaf: false,
          selfMute: false,
          debug: true,
        });

        // Intercept at the networking level — hook onUdpDebug to see all UDP traffic
        // and patch the socket via the networking object's onUdpDebug handler
        guildState.connection.on("stateChange", (oldState, newState) => {
          console.log(`[DEBUG] Voice state: ${oldState.status} → ${newState.status}`);
          const networking = newState?.networking;
          if (!networking) return;
          const code = networking.state?.code ?? networking._state?.code;
          console.log(`[DEBUG] Networking code: ${code}`);

          // Override onUdpDebug to spy on all UDP messages
          networking.onUdpDebug = (msg) => {
            console.log(`[DEBUG] UDP: ${msg}`);
          };

          // Try to find the UDP socket through all possible paths
          const findAndPatchSocket = (obj, depth, path) => {
            if (depth > 4 || !obj || typeof obj !== "object") return false;
            // Look for a dgram socket (has send, bind, address methods)
            if (typeof obj.send === "function" && typeof obj.bind === "function" && typeof obj.address === "function") {
              if (obj._ipPatched) return true;
              obj._ipPatched = true;
              console.log(`[DEBUG] ✅ Found UDP socket at: ${path}`);
              try { console.log(`[DEBUG] Socket address: ${JSON.stringify(obj.address())}`); } catch(e) {}
              const origEmit = obj.emit.bind(obj);
              obj.emit = (event, ...args) => {
                if (event === "message" && Buffer.isBuffer(args[0]) && args[0].length === 74) {
                  const buf = Buffer.from(args[0]);
                  if (buf.readUInt16BE(0) === 2) {
                    const nullIdx = buf.indexOf(0, 8);
                    const reportedIp = buf.slice(8, nullIdx > 8 ? nullIdx : 72).toString("ascii").replace(/ /g, "");
                    console.log(`[DEBUG] IP discovery response: reportedIp=${reportedIp}, publicIp=${publicIp}`);
                    if (publicIp && reportedIp && reportedIp !== publicIp) {
                      buf.fill(0, 8, 72);
                      buf.write(publicIp, 8, "ascii");
                      console.log(`[DEBUG] ✅ Rewrote IP: ${reportedIp} → ${publicIp}`);
                      return origEmit(event, buf, ...args.slice(1));
                    }
                  }
                }
                return origEmit(event, ...args);
              };
              return true;
            }
            for (const key of Object.keys(obj)) {
              try {
                if (findAndPatchSocket(obj[key], depth + 1, `${path}.${key}`)) return true;
              } catch(e) {}
            }
            return false;
          };

          // Try patching immediately and after a short delay
          const tryPatch = () => {
            const found = findAndPatchSocket(networking, 0, "networking");
            if (!found) console.log(`[DEBUG] Socket not found at this state, will retry`);
            return found;
          };

          if (!tryPatch()) {
            setTimeout(tryPatch, 100);
            setTimeout(tryPatch, 300);
          }
        });

        // Handle disconnects — auto-reconnect
        guildState.connection.on(VoiceConnectionStatus.Disconnected, async () => {
          console.log("[DEBUG] Disconnected — attempting reconnect...");
          try {
            await Promise.race([
              entersState(guildState.connection, VoiceConnectionStatus.Signalling, 5_000),
              entersState(guildState.connection, VoiceConnectionStatus.Connecting, 5_000),
            ]);
            console.log("[DEBUG] Reconnecting...");
          } catch {
            console.log("[DEBUG] Reconnect failed — destroying connection");
            guildState.connection.destroy();
            guildState.connection = null;
          }
        });

        // If stuck in signalling for >60s, destroy and let user rejoin
        // This happens when Fly.io doesn't have a dedicated IPv4 for Discord UDP
        let readyTimeout = setTimeout(() => {
          if (guildState.connection?.state?.status === VoiceConnectionStatus.Signalling ||
              guildState.connection?.state?.status === VoiceConnectionStatus.Connecting) {
            console.log("[DEBUG] ⚠️ Voice stuck in signalling after 60s — destroying. Ensure flyctl ips allocate-v4 has been run.");
            guildState.connection.destroy();
            guildState.connection = null;
          }
        }, 60_000);

        guildState.connection.once(VoiceConnectionStatus.Ready, () => {
          clearTimeout(readyTimeout);
          console.log("[DEBUG] ✅ Voice connection Ready — UDP established!");
        });

        guildState.connection.subscribe(guildState.audioPlayer);

        try { await interaction.editReply(`✅ Joined ${channel.name}! Waiting for voice connection...`); } catch {}
        await log("success", "bot_join", `Joined ${channel.name}`, { channel: channel.name, guild_id: guildId });
        startListening(guildState, channel);

      } catch (err) {
        console.error(`[DEBUG] Connection error: ${err.message}`);
        try { guildState.connection?.destroy(); } catch {}
        guildState.connection = null;
        try { await interaction.editReply(`❌ Failed to join voice: ${err.message}`); } catch {}
        await log("error", "error", `Failed to join: ${err.message}`, { guild_id: guildId });
      }
    }

    else if (interaction.commandName === "mute") {
      const guildState = getGuildState(guildId);
      if (!guildState.connection) { await safeReply("❌ Bot not in voice"); return; }
      guildState.isMuted = true;
      await safeReply("🔇 Bot muted");
    }

    else if (interaction.commandName === "unmute") {
      const guildState = getGuildState(guildId);
      if (!guildState.connection) { await safeReply("❌ Bot not in voice"); return; }
      guildState.isMuted = false;
      await safeReply("🔊 Bot unmuted");
    }

    else if (interaction.commandName === "leave") {
      const guildState = getGuildState(guildId);
      if (guildState.connection) {
        guildState.connection.destroy();
        guildState.connection = null;
        guildState.userState = {};
        guildState.isMuted = false;
        await safeReply("👋 Left voice");
      } else {
        await safeReply("❌ Not in voice");
      }
    }

  } catch (err) {
    console.error("[DEBUG] interactionCreate error (caught):", err.message);
  }
});

// ✅ Pipe raw Opus stream directly into ffmpeg — no native decoder needed
// Per Discord voice docs: audio is 48kHz 2ch Opus frames (960 samples = 20ms each)
const processingUsers = new Set();

function startListening(guildState, channel) {
  const receiver = guildState.connection.receiver;
  console.log(`[DEBUG] ✅ startListening for ${channel.name}`);
  // Attach immediately — speaking events will fire once UDP is established
  attachSpeakingListener(guildState, channel, receiver);
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

    // Subscribe to Opus stream — @discordjs/voice decodes to PCM via prism-media
    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_TIMEOUT_MS },
    });

    const wavPath = path.join("/tmp", `audio_${userId}_${Date.now()}.wav`);

    // @discordjs/voice receiver gives decoded PCM: 48kHz, 2ch, signed 16-bit LE
    const ffmpeg = spawn(ffmpegPath, [
      "-f", "s16le",         // Input: raw signed 16-bit LE PCM
      "-ar", "48000",        // Input sample rate: 48kHz (Discord standard)
      "-ac", "2",            // Input channels: stereo
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
}

async function processAudio(guildState, wavPath, userId, username, channelName, startMs) {
  // wavPath is already a 16kHz mono WAV file ready for Whisper (converted by ffmpeg in startListening)
  const mp3Path = path.join("/tmp", `tts_${Date.now()}.mp3`);

  try {
    console.log(`[DEBUG] Transcribing WAV with Whisper: ${wavPath}`);
    const transcription = await getOpenAI().audio.transcriptions.create({ 
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
    const gptRes = await getOpenAI().chat.completions.create({
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
    const audioStream = await getElevenLabs().textToSpeech.convert(process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM", {
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
        const audioStream = await getElevenLabs().textToSpeech.convert(process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM", {
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
        const audioStream = await getElevenLabs().textToSpeech.convert(process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM", {
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

// Start HTTP health server FIRST — before anything else so Fly.io health checks pass immediately
const http = require("http");
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("OK");
}).listen(PORT, "0.0.0.0", () => {
  console.log(`[DEBUG] Health server listening on 0.0.0.0:${PORT}`);
});

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