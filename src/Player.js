import React, { useEffect, useRef } from "react";

import Plyr from "plyr";
import "plyr/dist/plyr.css";

import Hls from "hls.js";
import mpegts from "mpegts.js";

function Player({ src }) {
  const videoRef = useRef(null);

  const playerRef = useRef(null);
  const mpegtsRef = useRef(null);
  const hlsRef = useRef(null);

  const destroyedRef = useRef(false);
  const startedRef = useRef(false);

  /*
   * Relay local.
   *
   * Se quiser mudar a porta posteriormente:
   *
   * REACT_APP_STREAM_RELAY_URL=http://localhost:3001
   *
   * Caso a variavel nao exista, usamos localhost:3001.
   */
  const relayBase =
    process.env.REACT_APP_STREAM_RELAY_URL ||
    "http://localhost:3001";

  /*
   * Quantos segundos queremos acumular antes de
   * iniciar a reproducao.
   */
  const START_BUFFER_SECONDS = 20;

  useEffect(() => {
    if (!src || !videoRef.current) {
      return;
    }

    destroyedRef.current = false;
    startedRef.current = false;

    const video = videoRef.current;

    /*
     * Garante comportamento adequado em navegadores modernos.
     */
    video.playsInline = true;

    /*
     * Nao forçamos muted.
     *
     * O navegador pode bloquear autoplay com audio.
     * Nesse caso o usuario simplesmente precisara clicar
     * no Play do Plyr.
     */
    video.autoplay = false;

    /*
     * -----------------------------------------------
     * LIMPEZA
     * -----------------------------------------------
     */
    const cleanup = () => {
      destroyedRef.current = true;

      console.log("[Player] Limpando player...");

      /*
       * Para HLS
       */
      if (hlsRef.current) {
        try {
          hlsRef.current.stopLoad();
        } catch (error) {
          console.warn(
            "[Player] Erro ao parar HLS:",
            error
          );
        }

        try {
          hlsRef.current.destroy();
        } catch (error) {
          console.warn(
            "[Player] Erro ao destruir HLS:",
            error
          );
        }

        hlsRef.current = null;
      }

      /*
       * Para MPEG-TS
       *
       * IMPORTANTE:
       *
       * Isso so acontece quando o componente realmente
       * vai ser desmontado ou o src mudar.
       *
       * NAO fazemos destroy quando uma janela TS termina.
       */
      if (mpegtsRef.current) {
        try {
          mpegtsRef.current.pause();
        } catch (error) {
          console.warn(
            "[Player] Erro ao pausar MPEG-TS:",
            error
          );
        }

        try {
          mpegtsRef.current.unload();
        } catch (error) {
          console.warn(
            "[Player] Erro ao descarregar MPEG-TS:",
            error
          );
        }

        try {
          mpegtsRef.current.detachMediaElement();
        } catch (error) {
          console.warn(
            "[Player] Erro ao desanexar MPEG-TS:",
            error
          );
        }

        try {
          mpegtsRef.current.destroy();
        } catch (error) {
          console.warn(
            "[Player] Erro ao destruir MPEG-TS:",
            error
          );
        }

        mpegtsRef.current = null;
      }

      /*
       * Plyr
       */
      if (playerRef.current) {
        try {
          playerRef.current.destroy();
        } catch (error) {
          console.warn(
            "[Player] Erro ao destruir Plyr:",
            error
          );
        }

        playerRef.current = null;
      }

      startedRef.current = false;
    };

    /*
     * -----------------------------------------------
     * PLYR
     * -----------------------------------------------
     */

    playerRef.current = new Plyr(video, {
      controls: [
        "play-large",
        "play",
        "mute",
        "volume",
        "fullscreen",
      ],

      settings: [],

      clickToPlay: true,

      /*
       * Esconde automaticamente os controles depois
       * de alguns segundos sem interação.
       */
      hideControls: true,

      /*
       * Faz os controles aparecerem novamente quando
       * o mouse/toque interagir com o player.
       */
      resetOnEnd: false,

      keyboard: {
        focused: true,
        global: false,
      },
    });

    /*
     * -----------------------------------------------
     * BUFFER
     * -----------------------------------------------
     */

    const getBufferedSeconds = () => {
      if (!video.buffered || video.buffered.length === 0) {
        return 0;
      }

      const currentTime = video.currentTime || 0;

      /*
       * Procuramos a faixa que contém o currentTime.
       */
      for (let i = 0; i < video.buffered.length; i++) {
        const start = video.buffered.start(i);
        const end = video.buffered.end(i);

        if (
          currentTime >= start &&
          currentTime <= end
        ) {
          return Math.max(0, end - currentTime);
        }
      }

      /*
       * Se nao encontramos a faixa atual, usamos
       * a ultima faixa disponivel.
       */
      const lastIndex = video.buffered.length - 1;

      const end = video.buffered.end(lastIndex);

      return Math.max(0, end - currentTime);
    };

    /*
     * -----------------------------------------------
     * PLAYBACK
     * -----------------------------------------------
     */

    const tryStartPlayback = async () => {
      if (destroyedRef.current) {
        return;
      }

      if (startedRef.current) {
        return;
      }

      const buffered = getBufferedSeconds();

      console.log(
        `[Player] Buffer atual: ${buffered.toFixed(2)}s`
      );

      if (buffered < START_BUFFER_SECONDS) {
        return;
      }

      console.log(
        `[Player] Buffer de ${START_BUFFER_SECONDS}s atingido.`
      );

      startedRef.current = true;

      try {
        await video.play();

        console.log("[Player] Playback iniciado.");
      } catch (error) {
        /*
         * Chrome normalmente cai aqui quando o autoplay
         * com audio nao foi autorizado.
         *
         * NAO tratamos isso como erro fatal.
         */
        console.warn(
          "[Player] Autoplay bloqueado pelo navegador.",
          error
        );

        console.log(
          "[Player] Clique em Play para iniciar."
        );

        /*
         * Permite nova tentativa quando o usuario clicar.
         */
        startedRef.current = false;
      }
    };

    /*
     * -----------------------------------------------
     * MONITOR DO BUFFER
     * -----------------------------------------------
     */

    const bufferMonitor = setInterval(() => {
      if (destroyedRef.current) {
        return;
      }

      const buffered = getBufferedSeconds();

      if (buffered > 0) {
        console.log(
          `[Player] Buffer: ${buffered.toFixed(2)}s | ` +
          `currentTime: ${video.currentTime.toFixed(2)} | ` +
          `bufferEnd: ${video.buffered.length > 0
            ? video.buffered
              .end(video.buffered.length - 1)
              .toFixed(2)
            : "N/A"
          }`
        );
      }

      /*
       * Espera os 20 segundos iniciais.
       */
      if (!startedRef.current) {
        tryStartPlayback();
      }
    }, 2000);

    /*
     * -----------------------------------------------
     * EVENTOS DO VIDEO
     * -----------------------------------------------
     */

    const handleWaiting = () => {
      console.warn(
        "[Player] Video entrou em WAITING."
      );

      const buffered = getBufferedSeconds();

      console.log(
        `[Player] Buffer durante waiting: ${buffered.toFixed(
          2
        )}s`
      );
    };

    const handlePlaying = () => {
      console.log("[Player] Evento PLAYING.");
    };

    const handleCanPlay = () => {
      console.log("[Player] Evento CANPLAY.");

      if (!startedRef.current) {
        tryStartPlayback();
      }
    };

    const handleError = (event) => {
      console.error(
        "[Player] Erro no elemento de video:",
        event
      );
    };

    video.addEventListener("waiting", handleWaiting);
    video.addEventListener("playing", handlePlaying);
    video.addEventListener("canplay", handleCanPlay);
    video.addEventListener("error", handleError);

    /*
     * -----------------------------------------------
     * HLS
     * -----------------------------------------------
     */

    const startHls = () => {
      console.log("[Player] Iniciando HLS:", src);

      const hls = new Hls({
        maxBufferLength: 40,
        maxMaxBufferLength: 60,
        maxBufferSize: 100 * 1000 * 1000,

        backBufferLength: 30,

        initialLiveManifestSize: 4,

        liveSyncDuration: 20,
        liveMaxLatencyDuration: 60,

        nudgeOffset: 0.2,
        nudgeMaxRetry: 5,

        highBufferWatchdogPeriod: 2,

        enableWorker: true,

        /*
         * Evita que HLS fique tentando controlar
         * agressivamente a latencia.
         */
        lowLatencyMode: false,
      });

      hlsRef.current = hls;

      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        console.log(
          "[Player] HLS conectado ao elemento video."
        );

        hls.loadSource(src);
      });

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log(
          "[Player] Manifest HLS carregado."
        );

        tryStartPlayback();
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        console.error(
          "[Player] HLS error:",
          data
        );

        if (!data.fatal) {
          return;
        }

        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            console.warn(
              "[Player] HLS network error. Tentando novamente..."
            );

            try {
              hls.startLoad();
            } catch (error) {
              console.error(
                "[Player] Falha no startLoad:",
                error
              );
            }

            break;

          case Hls.ErrorTypes.MEDIA_ERROR:
            console.warn(
              "[Player] HLS media error. Recuperando..."
            );

            try {
              hls.recoverMediaError();
            } catch (error) {
              console.error(
                "[Player] Falha no recoverMediaError:",
                error
              );
            }

            break;

          default:
            console.error(
              "[Player] Erro HLS fatal."
            );

            try {
              hls.destroy();
            } catch (error) {
              console.error(error);
            }

            break;
        }
      });

      hls.attachMedia(video);
    };

    /*
     * -----------------------------------------------
     * MPEG-TS
     * -----------------------------------------------
     */

    const startMpegTs = () => {
      /*
       * Montamos a URL do relay.

       * O src original continua sendo algo como:
       *
       * http://corruptx.org/.../43933.ts
       *
       * Mas o navegador agora acessa:
       *
       * http://localhost:3001/stream?url=...
       */
      const relayUrl =
        `${relayBase}/stream?url=` +
        encodeURIComponent(src);

      console.log(
        "[Player] Iniciando MPEG-TS pelo relay:"
      );

      console.log(relayUrl);

      const player = mpegts.createPlayer(
        {
          type: "mpegts",

          isLive: true,

          url: relayUrl,
        },
        {
          /*
           * Worker ajuda o processamento do MPEG-TS.
           */
          enableWorker: true,

          /*
           * Mantemos stash habilitado.
           */
          enableStashBuffer: true,

          /*
           * 2 MB de stash inicial.
           *
           * O buffer de 20 segundos sera controlado
           * pelo MediaSource, nao apenas por este valor.
           */
          stashInitialSize: 2 * 1024 * 1024,

          /*
           * Nao fazer lazy load.
           */
          lazyLoad: false,

          /*
           * Nao perseguir a latencia automaticamente.
           */
          liveBufferLatencyChasing: false,

          /*
           * Mantem uma margem razoavel.
           */
          liveBufferLatencyMaxLatency: 40,

          /*
           * Tentativa de recuperacao de erro.
           */
          autoCleanupSourceBuffer: false,
        }
      );

      mpegtsRef.current = player;

      /*
       * -------------------------------------------
       * MPEG-TS EVENTS
       * -------------------------------------------
       */

      player.on(
        mpegts.Events.ERROR,
        (type, detail, info) => {
          console.error(
            "[Player] MPEG-TS ERROR:",
            type,
            detail,
            info
          );
        }
      );

      player.on(
        mpegts.Events.MEDIA_INFO,
        (info) => {
          console.log(
            "[Player] MPEG-TS MEDIA_INFO:",
            info
          );

          /*
           * Nao iniciamos imediatamente.
           *
           * O monitor vai esperar os 20 segundos.
           */
          tryStartPlayback();
        }
      );

      player.on(
        mpegts.Events.LOADING_COMPLETE,
        () => {
          /*
           * IMPORTANTE:
           *
           * Com o relay, esperamos que esse evento
           * praticamente nunca represente o fim do canal.
           *
           * Se aparecer, NAO destruimos o player aqui.
           */
          console.warn(
            "[Player] MPEG-TS LOADING_COMPLETE."
          );

          console.warn(
            "[Player] O relay deveria manter a conexao aberta."
          );
        }
      );

      player.on(
        mpegts.Events.STATISTICS_INFO,
        (statistics) => {
          /*
           * Mantemos esse evento sem spam excessivo.
           */
        }
      );

      /*
       * -------------------------------------------
       * MEDIA ELEMENT
       * -------------------------------------------
       */

      player.attachMediaElement(video);

      player.load();

      console.log(
        "[Player] MPEG-TS carregando..."
      );
    };

    /*
     * -----------------------------------------------
     * DETECTA TIPO
     * -----------------------------------------------
     */

    const lowerSrc = src.toLowerCase();

    if (
      lowerSrc.includes(".m3u8") ||
      lowerSrc.includes("application/vnd.apple.mpegurl")
    ) {
      /*
       * HLS
       */
      if (Hls.isSupported()) {
        startHls();
      } else if (
        video.canPlayType("application/vnd.apple.mpegurl")
      ) {
        console.log(
          "[Player] Usando HLS nativo do navegador."
        );

        video.src = src;

        video.addEventListener(
          "loadedmetadata",
          tryStartPlayback,
          {
            once: true,
          }
        );
      } else {
        console.error(
          "[Player] HLS nao suportado neste navegador."
        );
      }
    } else if (
      lowerSrc.includes(".ts") ||
      lowerSrc.includes("mpegts")
    ) {
      /*
       * MPEG-TS
       *
       * SEMPRE passa pelo relay.
       */
      if (!mpegts.isSupported()) {
        console.error(
          "[Player] MPEG-TS nao suportado neste navegador."
        );
      } else {
        startMpegTs();
      }
    } else {
      /*
       * Fallback para formatos que o navegador consiga
       * reproduzir diretamente.
       */
      console.log(
        "[Player] Formato direto:",
        src
      );

      video.src = src;

      video.addEventListener(
        "loadedmetadata",
        tryStartPlayback,
        {
          once: true,
        }
      );
    }

    /*
     * -----------------------------------------------
     * CLICK NO PLAY
     * -----------------------------------------------
     *
     * Se o Chrome bloquear autoplay, o usuario pode
     * clicar manualmente no Play.
     */

    const handleUserPlay = () => {
      startedRef.current = true;
    };

    video.addEventListener("play", handleUserPlay);

    /*
     * -----------------------------------------------
     * CLEANUP
     * -----------------------------------------------
     */

    return () => {
      clearInterval(bufferMonitor);

      video.removeEventListener(
        "waiting",
        handleWaiting
      );

      video.removeEventListener(
        "playing",
        handlePlaying
      );

      video.removeEventListener(
        "canplay",
        handleCanPlay
      );

      video.removeEventListener(
        "error",
        handleError
      );

      video.removeEventListener(
        "play",
        handleUserPlay
      );

      cleanup();
    };
  }, [src, relayBase]);

  return (
    <div className="player-container">
      <video
        ref={videoRef}
        className="video-js"
        playsInline
      />
    </div>
  );
}

export default Player;