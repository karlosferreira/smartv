import React, { useEffect, useRef } from "react";
import Plyr from "plyr";
import "plyr/dist/plyr.css";
import Hls from "hls.js";

const Player = ({ src }) => {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const retryTimeoutRef = useRef(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Inicializa o player com autoplay ativado
    const player = new Plyr(video, { autoplay: true });

    const setupHls = () => {
      if (Hls.isSupported() && src.endsWith(".m3u8")) {
        const hls = new Hls();
        hls.loadSource(src);
        hls.attachMedia(video);
        hlsRef.current = hls;

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          // Força o autoplay após o carregamento
          video.play().catch((err) => console.warn("Autoplay bloqueado:", err));
        });

        hls.on(Hls.Events.ERROR, (_, data) => {
          if (data.fatal) {
            console.warn("Erro fatal no HLS, tentando reconectar...", data);
            clearTimeout(retryTimeoutRef.current);

            retryTimeoutRef.current = setTimeout(() => {
              hls.destroy();
              setupHls(); // Recarrega o HLS

              // Força autoplay após um curto intervalo
              setTimeout(() => {
                video.play().catch((err) =>
                  console.warn("Autoplay bloqueado após reconexão:", err)
                );
              }, 1000);
            }, 10000); // Aguarda 10 segundos antes de tentar novamente
          }
        });

        return () => {
          hls.destroy();
          clearTimeout(retryTimeoutRef.current);
        };
      } else {
        video.src = src;
        video.play().catch((err) => console.warn("Autoplay bloqueado:", err));
      }
    };

    setupHls();

    // Reinicia automaticamente ao término
    video.addEventListener("ended", () => {
      video.currentTime = 0;
      video.play().catch((err) =>
        console.warn("Autoplay bloqueado após término:", err)
      );
    });

    return () => {
      player.destroy();
      clearTimeout(retryTimeoutRef.current);
      if (hlsRef.current) {
        hlsRef.current.destroy();
      }
    };
  }, [src]);

  return (
    <div className="video-container">
      <video ref={videoRef} className="plyr" controls />
    </div>
  );
};

export default Player;
