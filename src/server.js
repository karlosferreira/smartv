
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

// ============================================================
// CONFIGURAÇÃO
// ============================================================

const PORT = Number(process.env.PORT || 3001);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

const OVERLAP_GUARD = 0.35;
const MIN_SEGMENT_DURATION = 0.75;
const MAX_EXTRA_DURATION = 1.20;

const VIDEO_BITRATE = "1600k";
const VIDEO_MAXRATE = "1800k";
const VIDEO_BUFSIZE = "3600k";

const AUDIO_BITRATE = "128k";
const REQUEST_DELAY = 150;
const PROBE_SIZE = "15M";
const ANALYZE_DURATION = "15M";

const LOG_PREFIX = "[Relay]";

// ============================================================
// ERROS
// ============================================================

class SourceHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "SourceHttpError";
    this.status = status;
    this.fatal =
      status === 401 ||
      status === 403 ||
      status === 404;
  }
}

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function sleep(ms, signal) {
  if (signal?.aborted) {
    return Promise.reject(new Error("Operação cancelada"));
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Operação cancelada"));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function formatSeconds(value) {
  return Number.isFinite(value) ? `${value.toFixed(3)}s` : "N/A";
}

// ============================================================
// EXECUÇÃO DE PROCESSOS
// ============================================================

function runProcess(command, args, options = {}) {
  const {
    signal,
    cwd,
    onStderr,
  } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Operação cancelada"));
      return;
    }

    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;

      signal?.removeEventListener("abort", abortProcess);

      if (error) reject(error);
      else resolve(result);
    };

    const abortProcess = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    };

    signal?.addEventListener("abort", abortProcess, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;

      if (stderr.length > 2_000_000) {
        stderr = stderr.slice(-1_000_000);
      }

      if (onStderr) onStderr(chunk);
    });

    child.on("error", (error) => {
      finish(error);
    });

    child.on("close", (code, signalName) => {
      if (signal?.aborted) {
        finish(new Error("Operação cancelada"));
        return;
      }

      if (code !== 0) {
        finish(
          new Error(
            `${command} terminou com código ${code}` +
            (signalName ? ` (${signalName})` : "") +
            `\n${stderr.slice(-12000)}`
          )
        );
        return;
      }

      finish(null, { stdout, stderr });
    });
  });
}

// ============================================================
// DOWNLOAD DA JANELA
// ============================================================

async function downloadToFile(url, outputPath, signal) {
  const response = await fetch(url, {
    signal,
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 IPTV-Relay/7.0",
      accept: "*/*",
    },
  });

  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {}

    throw new SourceHttpError(
      response.status,
      `Origem respondeu HTTP ${response.status}`
    );
  }

  if (!response.body) {
    throw new Error("A origem não retornou um corpo de resposta");
  }

  const fileHandle = await fs.open(outputPath, "w");

  try {
    const reader = response.body.getReader();

    while (true) {
      if (signal?.aborted) {
        throw new Error("Download cancelado");
      }

      const { done, value } = await reader.read();

      if (done) break;

      if (value?.length) {
        await fileHandle.write(value);
      }
    }
  } catch (error) {
    try {
      await response.body.cancel();
    } catch {}

    throw error;
  } finally {
    await fileHandle.close();
  }

  const stat = await fs.stat(outputPath);

  if (stat.size < 188) {
    throw new Error(
      `Arquivo TS muito pequeno: ${stat.size} bytes`
    );
  }

  return stat.size;
}

// ============================================================
// FFPROBE
// ============================================================

async function probeMedia(filePath, signal) {
  const { stdout } = await runProcess(
    FFPROBE,
    [
      "-v", "error",
      "-show_entries",
      "format=start_time,duration:" +
        "stream=index,codec_type,start_time,duration,nb_frames",
      "-of", "json",
      filePath,
    ],
    { signal }
  );

  const data = JSON.parse(stdout);
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const format = data.format || {};

  const video = streams.find(
    (stream) => stream.codec_type === "video"
  );

  const audio = streams.find(
    (stream) => stream.codec_type === "audio"
  );

  const formatStart = Number(format.start_time);
  const formatDuration = Number(format.duration);

  const videoStart = Number(video?.start_time);
  const videoDuration = Number(video?.duration);

  const audioStart = Number(audio?.start_time);
  const audioDuration = Number(audio?.duration);

  return {
    startTime: Number.isFinite(formatStart)
      ? formatStart
      : Number.isFinite(videoStart)
        ? videoStart
        : 0,

    duration: formatDuration,

    videoStartTime: Number.isFinite(videoStart)
      ? videoStart
      : null,

    videoDuration: Number.isFinite(videoDuration)
      ? videoDuration
      : null,

    audioStartTime: Number.isFinite(audioStart)
      ? audioStart
      : null,

    audioDuration: Number.isFinite(audioDuration)
      ? audioDuration
      : null,

    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    streams,
  };
}

// ============================================================
// RECUPERAÇÃO DO SEGMENTO
//
// Importante na v7:
// - cada segmento começa em timestamps locais;
// - NÃO aplicar playerTimelineEnd no setpts;
// - a continuidade temporal é responsabilidade do muxer;
// - cada segmento recebe um novo GOP.
// ============================================================

async function recoverSegment({
  inputPath,
  outputPath,
  trimSeconds,
  expectedDuration,
  hasAudio,
  signal,
}) {
  const args = [
    "-hide_banner",
    "-loglevel", "warning",

    "-fflags", "+genpts+discardcorrupt",
    "-err_detect", "ignore_err",

    "-analyzeduration", ANALYZE_DURATION,
    "-probesize", PROBE_SIZE,

    "-i", inputPath,

    "-ss", String(Math.max(0, trimSeconds)),
    "-t", String(expectedDuration),

    "-map", "0:v:0",
  ];

  if (hasAudio) {
    args.push("-map", "0:a:0?");
  }

  args.push(
    "-sn",
    "-dn",

    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "zerolatency",
    "-pix_fmt", "yuv420p",

    "-r", "30",
    "-g", "60",
    "-keyint_min", "60",
    "-sc_threshold", "0",

    "-b:v", VIDEO_BITRATE,
    "-maxrate", VIDEO_MAXRATE,
    "-bufsize", VIDEO_BUFSIZE,

    // Timestamps locais: zero por segmento.
    "-vf", "setpts=PTS-STARTPTS"
  );

  if (hasAudio) {
    args.push(
      "-c:a", "aac",
      "-b:a", AUDIO_BITRATE,
      "-ar", "48000",
      "-ac", "2",
      "-af", "asetpts=PTS-STARTPTS"
    );
  } else {
    args.push("-an");
  }

  args.push(
    "-mpegts_flags", "+resend_headers",
    "-pat_period", "0.5",
    "-pcr_period", "20",
    "-muxdelay", "0",
    "-muxpreload", "0",
    "-f", "mpegts",
    "-y",
    outputPath
  );

  let diagnosticBuffer = "";

  const result = await runProcess(FFMPEG, args, {
    signal,
    onStderr(chunk) {
      diagnosticBuffer += chunk;

      if (diagnosticBuffer.length > 16000) {
        diagnosticBuffer = diagnosticBuffer.slice(-8000);
      }

      const lines = diagnosticBuffer.split(/\r?\n/);
      diagnosticBuffer = lines.pop() || "";

      for (const line of lines) {
        if (
          /error|invalid|corrupt|decode|non.?monotonic/i.test(line)
        ) {
          console.warn("[FFmpeg recuperação]", line.trim());
        }
      }
    },
  });

  if (result.stderr) {
    const important = result.stderr
      .split(/\r?\n/)
      .filter((line) =>
        /error|invalid|corrupt|non.?monotonic/i.test(line)
      );

    for (const line of important.slice(-8)) {
      console.warn("[FFmpeg recuperação]", line.trim());
    }
  }

  const stat = await fs.stat(outputPath);

  if (stat.size < 188) {
    throw new Error(
      `FFmpeg gerou um TS inválido (${stat.size} bytes)`
    );
  }

  return stat.size;
}

// ============================================================
// MUXER CONTÍNUO
//
// v7:
// - sem -copyts;
// - corrige descontinuidades de timestamps na entrada MPEG-TS;
// - preserva os codecs dos segmentos recuperados;
// - mantém um único muxer durante todo o relay.
// ============================================================

function createContinuousMuxer(signal) {
  const args = [
    "-hide_banner",
    "-loglevel", "warning",

    // Opções de entrada: corrigir saltos de DTS/PTS
    // encontrados entre segmentos MPEG-TS concatenados.
    "-fflags", "+genpts+discardcorrupt",
    "-dts_delta_threshold", "1",

    "-probesize", PROBE_SIZE,
    "-analyzeduration", ANALYZE_DURATION,

    "-f", "mpegts",
    "-i", "pipe:0",

    "-map", "0:v:0",
    "-map", "0:a:0?",

    // Os segmentos já foram recuperados e codificados.
    "-c", "copy",

    // Intencionalmente NÃO usar -copyts.
    // A entrada pode reiniciar timestamps a cada segmento.

    "-mpegts_flags", "+resend_headers",
    "-pat_period", "0.5",
    "-pcr_period", "20",
    "-muxdelay", "0",
    "-muxpreload", "0",
    "-flush_packets", "1",

    "-f", "mpegts",
    "pipe:1",
  ];

  const child = spawn(FFMPEG, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stderr.setEncoding("utf8");

  let stderrBuffer = "";

  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk;

    if (stderrBuffer.length > 30000) {
      stderrBuffer = stderrBuffer.slice(-15000);
    }

    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() || "";

    for (const line of lines) {
      const message = line.trim();

      if (!message) continue;

      if (/non.?monotonic dts/i.test(message)) {
        console.error("[Muxer DTS]", message);
      } else if (/error|invalid|corrupt/i.test(message)) {
        console.warn("[Muxer]", message);
      }
    }
  });

  child.on("error", (error) => {
    console.error("[Muxer] Erro no processo:", error.message);
  });

  child.on("close", (code, signalName) => {
    if (code !== 0 && code !== null) {
      console.error(
        `[Muxer] Encerrado com código ${code}` +
        (signalName ? ` (${signalName})` : "")
      );
    }
  });

  const abortMuxer = () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  };

  signal?.addEventListener("abort", abortMuxer, { once: true });

  return child;
}

// ============================================================
// ENVIAR UM ARQUIVO TS AO MUXER SEM FECHAR O PIPE
// ============================================================

async function feedFileToMuxer(filePath, muxer, signal) {
  if (muxer.stdin.destroyed || muxer.stdin.writableEnded) {
    throw new Error("O pipe de entrada do muxer foi encerrado");
  }

  const source = createReadStream(filePath);

  const abortSource = () => {
    source.destroy(new Error("Envio cancelado"));
  };

  signal?.addEventListener("abort", abortSource, { once: true });

  try {
    for await (const chunk of source) {
      if (signal?.aborted) {
        throw new Error("Envio cancelado");
      }

      if (muxer.stdin.destroyed || muxer.stdin.writableEnded) {
        throw new Error("O muxer encerrou o pipe de entrada");
      }

      if (!muxer.stdin.write(chunk)) {
        await once(muxer.stdin, "drain");
      }
    }
  } finally {
    signal?.removeEventListener("abort", abortSource);
    source.destroy();
  }
}

// ============================================================
// RELAY PRINCIPAL
// ============================================================

async function runRelay({ url, req, res, controller }) {
  const signal = controller.signal;
  const tempDir = path.join(
    os.tmpdir(),
    `iptv-relay-v7-${crypto.randomBytes(6).toString("hex")}`
  );

  await fs.mkdir(tempDir, { recursive: true });

  let sourceTimelineEnd = null;
  let playerTimelineEnd = 0;
  let windowNumber = 0;
  let successfulSegments = 0;
  let muxer = null;
  let clientGone = false;

  const markClientGone = () => {
    if (clientGone) return;

    clientGone = true;

    if (!signal.aborted) {
      log("Cliente desconectou; encerrando relay.");
      controller.abort();
    }

    if (
      muxer &&
      muxer.exitCode === null &&
      muxer.signalCode === null
    ) {
      muxer.kill("SIGKILL");
    }
  };

  const onRequestAborted = () => markClientGone();

  const onResponseClose = () => {
    if (!res.writableEnded) {
      markClientGone();
    }
  };

  req.once("aborted", onRequestAborted);
  res.once("close", onResponseClose);

  try {
    muxer = createContinuousMuxer(signal);

    // Iniciar o envio de saída imediatamente.
    muxer.stdout.pipe(res);

    muxer.stdout.on("error", (error) => {
      if (!signal.aborted) {
        console.error("[Relay] Erro na saída do muxer:", error.message);
        controller.abort();
      }
    });

    muxer.stdin.on("error", (error) => {
      if (!signal.aborted) {
        console.error("[Relay] Erro na entrada do muxer:", error.message);
      }
    });

    muxer.on("close", (code) => {
      if (!signal.aborted && code !== 0 && code !== null) {
        log(`Muxer terminou inesperadamente com código ${code}.`);
      }
    });

    while (!signal.aborted) {
      windowNumber += 1;

      const inputPath = path.join(
        tempDir,
        `input-${windowNumber}.ts`
      );

      const outputPath = path.join(
        tempDir,
        `recovered-${windowNumber}.ts`
      );

      try {
        log(`Baixando janela #${windowNumber}...`);

        const bytes = await downloadToFile(url, inputPath, signal);

        log(
          `Janela #${windowNumber}: ` +
          `${(bytes / 1024 / 1024).toFixed(2)} MB baixados.`
        );

        const source = await probeMedia(inputPath, signal);

        if (
          !source.hasVideo ||
          !Number.isFinite(source.startTime) ||
          !Number.isFinite(source.duration) ||
          source.duration <= 0
        ) {
          throw new Error(
            "Janela de origem inválida: vídeo, início ou duração ausente"
          );
        }

        const sourceEnd = source.startTime + source.duration;

        log(
          `Origem: início=${formatSeconds(source.startTime)}, ` +
          `duração=${formatSeconds(source.duration)}, ` +
          `fim=${formatSeconds(sourceEnd)}`
        );

        if (sourceTimelineEnd === null) {
          sourceTimelineEnd = source.startTime;
        }

        // A janela inteira já está coberta por dados anteriores.
        if (sourceEnd <= sourceTimelineEnd + 0.001) {
          log(
            `Janela #${windowNumber} totalmente coberta; descartada.`
          );

          await fs.rm(inputPath, { force: true });
          await sleep(REQUEST_DELAY, signal);
          continue;
        }

        // Remover a parte sobreposta e uma pequena margem de segurança.
        let trimSeconds = Math.max(
          0,
          sourceTimelineEnd - source.startTime + OVERLAP_GUARD
        );

        trimSeconds = Math.min(trimSeconds, source.duration);

        const expectedDuration = source.duration - trimSeconds;

        if (expectedDuration < MIN_SEGMENT_DURATION) {
          log(
            `Janela #${windowNumber} descartada: ` +
            `restam somente ${formatSeconds(expectedDuration)}.`
          );

          await fs.rm(inputPath, { force: true });
          await sleep(REQUEST_DELAY, signal);
          continue;
        }

        log(
          `Janela #${windowNumber}: corte=${formatSeconds(trimSeconds)}, ` +
          `duração esperada=${formatSeconds(expectedDuration)}.`
        );

        await recoverSegment({
          inputPath,
          outputPath,
          trimSeconds,
          expectedDuration,
          hasAudio: source.hasAudio,
          signal,
        });

        const recovered = await probeMedia(outputPath, signal);

        if (!recovered.hasVideo) {
          throw new Error("FFmpeg não gerou uma faixa de vídeo");
        }

        const actualVideoDuration = recovered.videoDuration;

        if (
          !Number.isFinite(actualVideoDuration) ||
          actualVideoDuration < MIN_SEGMENT_DURATION
        ) {
          throw new Error(
            `Duração de vídeo recuperado inválida: ` +
            `${formatSeconds(actualVideoDuration)}`
          );
        }

        if (
          actualVideoDuration >
          expectedDuration + MAX_EXTRA_DURATION
        ) {
          throw new Error(
            `Duração recuperada excedeu o esperado: ` +
            `${formatSeconds(actualVideoDuration)} versus ` +
            `${formatSeconds(expectedDuration)}`
          );
        }

        const outputStat = await fs.stat(outputPath);

        if (outputStat.size < 188) {
          throw new Error("O arquivo recuperado não contém um TS válido");
        }

        log(
          `Recuperado: vídeo=${formatSeconds(actualVideoDuration)}, ` +
          `áudio=${formatSeconds(recovered.audioDuration)}, ` +
          `tamanho=${(outputStat.size / 1024 / 1024).toFixed(2)} MB.`
        );

        // Cada arquivo é enviado ao muxer contínuo. O arquivo começa
        // com timestamps locais; não adicionamos o offset do player aqui.
        await feedFileToMuxer(outputPath, muxer, signal);

        // Só contabilizar após o segmento ter sido incorporado ao pipe.
        playerTimelineEnd += actualVideoDuration;

        const actualSourceEnd =
          source.startTime + trimSeconds + actualVideoDuration;

        sourceTimelineEnd = Math.max(
          sourceTimelineEnd,
          Math.min(sourceEnd, actualSourceEnd)
        );

        successfulSegments += 1;

        log(
          `Janela #${windowNumber} incorporada com sucesso.`
        );

        log(
          `Timeline contabilizada do player: ` +
          `${formatSeconds(playerTimelineEnd)}`
        );

        log(
          `Origem aproveitada até: ` +
          `${formatSeconds(sourceTimelineEnd)}`
        );

        await fs.rm(inputPath, { force: true });
        await fs.rm(outputPath, { force: true });
      } catch (error) {
        await fs.rm(inputPath, { force: true }).catch(() => {});
        await fs.rm(outputPath, { force: true }).catch(() => {});

        if (signal.aborted) break;

        if (error instanceof SourceHttpError && error.fatal) {
          log(
            `Erro HTTP ${error.status} na origem; ` +
            `não é possível continuar: ${error.message}`
          );
          break;
        }

        log(
          `Janela #${windowNumber} não aproveitada: ${error.message}`
        );

        log("O relay continuará tentando a próxima janela.");
      }

      if (!signal.aborted) {
        await sleep(REQUEST_DELAY, signal).catch(() => {});
      }
    }
  } catch (error) {
    if (!signal.aborted) {
      console.error("[Relay] Erro:", error.message);
    }
  } finally {
    req.removeListener("aborted", onRequestAborted);
    res.removeListener("close", onResponseClose);

    if (muxer && muxer.exitCode === null && muxer.signalCode === null) {
      if (!signal.aborted && !muxer.stdin.destroyed) {
        muxer.stdin.end();
      } else {
        muxer.kill("SIGKILL");
      }

      if (muxer.exitCode === null && muxer.signalCode === null) {
        await once(muxer, "close").catch(() => {});
      }
    }

    await fs.rm(tempDir, {
      recursive: true,
      force: true,
    }).catch(() => {});

    log(
      `Relay finalizado. Janelas=${windowNumber}, ` +
      `segmentos incorporados=${successfulSegments}.`
    );

    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  }
}

// ============================================================
// SERVIDOR HTTP
// ============================================================

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Range"
  );

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  let requestUrl;

  try {
    requestUrl = new URL(
      req.url,
      `http://${req.headers.host || "localhost"}`
    );
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("URL de requisição inválida");
    return;
  }

  if (requestUrl.pathname !== "/stream") {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Endpoint não encontrado. Use /stream?url=...");
    return;
  }

  if (req.method !== "GET") {
    res.writeHead(405, {
      "Content-Type": "text/plain; charset=utf-8",
      Allow: "GET, OPTIONS",
    });
    res.end("Método não permitido");
    return;
  }

  const sourceUrl = requestUrl.searchParams.get("url");

  if (!sourceUrl) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Parâmetro obrigatório: url");
    return;
  }

  let parsedSourceUrl;

  try {
    parsedSourceUrl = new URL(sourceUrl);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("URL da origem inválida");
    return;
  }

  if (!["http:", "https:"].includes(parsedSourceUrl.protocol)) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("A origem precisa usar HTTP ou HTTPS");
    return;
  }

  res.writeHead(200, {
    "Content-Type": "video/mp2t",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  const controller = new AbortController();

  log(`Novo relay solicitado: ${parsedSourceUrl.hostname}`);

  await runRelay({
    url: parsedSourceUrl.toString(),
    req,
    res,
    controller,
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`IPTV Relay v7 rodando na porta ${PORT}`);
  console.log(`Endpoint: http://localhost:${PORT}/stream?url=URL_DA_ORIGEM`);
});

server.on("error", (error) => {
  console.error("[HTTP] Erro no servidor:", error);
});

process.on("SIGINT", () => {
  console.log("\nEncerrando servidor...");
  server.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  console.log("\nEncerrando servidor...");
  server.close(() => process.exit(0));
});