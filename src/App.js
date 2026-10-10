import { useEffect, useState } from "react";

import "./App.css";

import Player from "./Player";

function App() {
  const [groups, setGroups] = useState({});
  const [currentStream, setCurrentStream] = useState("");

  useEffect(() => {
    fetch("/playlists/smartv.m3u")
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Erro HTTP: ${res.status}`);
        }

        return res.text();
      })
      .then((text) => {
        const lines = text
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "");

        const parsedGroups = {};

        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith("#EXTINF")) {
            const details = lines[i];

            const nameParts = details.split(",");
            const name =
              nameParts.length > 1
                ? nameParts.slice(1).join(",").trim()
                : "Canal sem nome";

            const url = lines[i + 1];

            if (!url || url.startsWith("#")) {
              continue;
            }

            const groupMatch = details.match(/group-title="([^"]+)"/);
            const logoMatch = details.match(/tvg-logo="([^"]+)"/);

            const group = groupMatch
              ? groupMatch[1]
              : "Sem Categoria";

            const logo = logoMatch
              ? logoMatch[1]
              : "https://via.placeholder.com/100";

            if (!parsedGroups[group]) {
              parsedGroups[group] = [];
            }

            parsedGroups[group].push({
              name,
              url,
              logo,
            });
          }
        }

        setGroups(parsedGroups);

        // Seleciona automaticamente o primeiro canal
        const groupNames = Object.keys(parsedGroups);

        if (groupNames.length > 0) {
          const firstChannel = parsedGroups[groupNames[0]][0];

          if (firstChannel) {
            setCurrentStream(firstChannel.url);
          }
        }
      })
      .catch((err) => {
        console.error(
          "Erro ao carregar a playlist smartv.m3u:",
          err
        );
      });
  }, []);

  return (
    <div className="container">
      {/* Player em tela cheia */}
      {currentStream && (
        <Player
          key={currentStream}
          src={currentStream}
        />
      )}

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
                    onClick={() => setCurrentStream(item.url)}
                  >
                    <img
                      src={item.logo}
                      alt={item.name}
                    />

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