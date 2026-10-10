#!/bin/bash

# Nome do arquivo final M3U que listará todos os sub-m3u8 locais
PLAYLIST_FINAL="lista_canais.m3u"

# Inicializa o arquivo M3U final com o cabeçalho padrão
echo "#EXTM3U" > "$PLAYLIST_FINAL"

# Cria a pasta para organizar as novas playlists HLS criadas
mkdir -p ./processados

# Nome temporário para processamento interno
M3U8_ORIGINAL="CanaisBR02.m3u8"

if [ ! -f "$M3U8_ORIGINAL" ]; then
    echo "Erro: O arquivo $M3U8_ORIGINAL não foi encontrado na pasta atual!"
    exit 1
fi

echo "Analisando e convertendo a lista de canais..."
echo "--------------------------------------------------"

# Variáveis temporárias para armazenar os metadados durante a leitura da lista
INFO_EXTINF=""

# Lê o arquivo linha por linha
while IFS= read -r linha || [ -n "$linha" ]; do
    # Remove caracteres de retorno de carro (\r) comuns em arquivos do Windows
    linha=$(echo "$linha" | tr -d '\r')

    # Se a linha for um comentário de metadados do canal (#EXTINF)
    if [[ "$linha" =~ ^#EXTINF: ]]; then
        INFO_EXTINF="$linha"
        
        # Extrai o nome amigável do canal que fica após a última vírgula
        NOME_CANAL=$(echo "$linha" | awk -F',' '{print $NF}' | sed 's/[^a-zA-Z0-9_ -]/_/g' | sed 's/  */ /g')
        continue
    fi

    # Se a linha for a URL do stream do canal (começa com http)
    if [[ "$linha" =~ ^http ]]; then
        URL_STREAM="$linha"

        # Se não conseguimos extrair um nome válido, define um padrão com base no ID da URL
        if [ -z "$NOME_CANAL" ]; then
            NOME_CANAL=$(basename "$URL_STREAM" .ts)
        fi

        # Define as rotas dos arquivos locais que serão criados
        PASTA_CANAL="./processados/${NOME_CANAL}"
        M3U8_LOCAL="${PASTA_CANAL}/${NOME_CANAL}.m3u8"

        echo "Gerando estrutura HLS para: $NOME_CANAL"

        # Cria a subpasta do canal
        mkdir -p "$PASTA_CANAL"

        # ----------------------------------------------------------------
        # CRIAÇÃO DO PROXY HLS LOCAL:
        # Em vez de baixar o stream infinito, criamos um arquivo descritor HLS
        # padrão que aponta diretamente para o segmento vivo do servidor.
        # Isso faz o player entender como um .m3u8 nativo instantaneamente.
        # ----------------------------------------------------------------
        echo "#EXTM3U" > "$M3U8_LOCAL"
        echo "#EXT-X-VERSION:3" >> "$M3U8_LOCAL"
        echo "#EXT-X-TARGETDURATION:10" >> "$M3U8_LOCAL"
        echo "#EXT-X-MEDIA-SEQUENCE:0" >> "$M3U8_LOCAL"
        echo "#EXTINF:10.0," >> "$M3U8_LOCAL"
        echo "$URL_STREAM" >> "$M3U8_LOCAL"

        # Adiciona o canal convertido à playlist MASTER principal (.m3u)
        if [ -n "$INFO_EXTINF" ]; then
            echo "$INFO_EXTINF" >> "$PLAYLIST_FINAL"
        else
            echo "#EXTINF:-1, $NOME_CANAL" >> "$PLAYLIST_FINAL"
        fi
        echo "processados/${NOME_CANAL}/${NOME_CANAL}.m3u8" >> "$PLAYLIST_FINAL"

        # Limpa as variáveis para o próximo canal do loop
        NOME_CANAL=""
        INFO_EXTINF=""
    fi

done < "$M3U8_ORIGINAL"

echo "--------------------------------------------------"
echo "Processo concluído com sucesso!"
echo "Playlist Master criada em: $PLAYLIST_FINAL"
echo "Todos os canais foram convertidos para sub-m3u8 dentro da pasta './processados/'"
