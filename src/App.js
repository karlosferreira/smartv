import { useEffect, useState } from "react";
import "./App.css";
import Player from "./Player"; // Importa o player de IPTV

function App() {
  const [groups, setGroups] = useState({});
  const [currentStream, setCurrentStream] = useState(""); // Guarda a URL do canal ativo

  useEffect(() => {
    fetch("/playlists/live.m3u")
      .then((res) => res.text())
      .then((text) => {
        const lines = text.split("\n").map((line) => line.trim());
        const parsedGroups = {};

        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith("#EXTINF")) {
            const details = lines[i];
            const name = details.split(",")[1];
            const url = lines[i + 1];

            const groupMatch = details.match(/group-title="([^"]+)"/);
            const logoMatch = details.match(/tvg-logo="([^"]+)"/);
            const group = groupMatch ? groupMatch[1] : "Sem Categoria";
            const logo = logoMatch ? logoMatch[1] : "https://via.placeholder.com/100";

            if (!parsedGroups[group]) {
              parsedGroups[group] = [];
            }

            parsedGroups[group].push({ name, url, logo });
          }
        }

        setGroups(parsedGroups);

        // Definir o primeiro canal automaticamente como o currentStream
        const firstChannel = parsedGroups[Object.keys(parsedGroups)[0]][0];
        setCurrentStream(firstChannel.url); // Primeira URL
      })
      .catch((err) => console.error("Erro ao carregar a playlist:", err));
  }, []);

  return (
    <div className="container">
      {/* Player em tela cheia */}
      <Player key={currentStream} src={currentStream} />

      {/* Navigation Drawer - Lista de Canais */}
      <div className="channel-list-drawer">
        <div className="channel-list">
          {Object.keys(groups).map((group, index) => (
            <div key={index}>
              <div className="channel-grid">
                {groups[group].map((item, idx) => (
                  <div
                    key={idx}
                    className="channel-card"
                    onClick={() => setCurrentStream(item.url)} // Altera o player ao clicar
                  >
                    <img src={item.logo} alt={item.name} />
                    <p>{item.name}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default App;
