import React, { useEffect, useRef } from "react";
import Plyr from "plyr";
import "plyr/dist/plyr.css";
import Hls from "hls.js";

const Player = ({ src }) => {
  const videoRef = useRef(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Inicializa o player com autoplay ativado
    const player = new Plyr(video, { autoplay: true });

    // Verifica se o HLS é suportado para transmissões .m3u8
    if (Hls.isSupported() && src.endsWith(".m3u8")) {
      const hls = new Hls();
      hls.loadSource(src);
      hls.attachMedia(video);

      // Cleanup: destrói o HLS quando o efeito for limpo ou a URL mudar
      return () => {
        hls.destroy();
      };
    } else {
      // Se não for um .m3u8, apenas define o src diretamente
      video.src = src;
    }

    // Cleanup: destrói o player quando o efeito for limpo ou a URL mudar
    return () => {
      player.destroy();
    };
  }, [src]); // O efeito será executado sempre que o 'src' mudar

  return (
    <div className="video-container">
      <video ref={videoRef} className="plyr" controls />
    </div>
  );
};

export default Player;
