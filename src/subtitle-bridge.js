(() => {
  const source = 'echo-translate-subtitles';
  function readTracks() {
    let response = window.ytInitialPlayerResponse;
    const player = document.getElementById('movie_player');
    if (typeof player?.getPlayerResponse === 'function') {
      try { response = player.getPlayerResponse() || response; } catch { /* Player may be transitioning between videos. */ }
    }
    const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    return tracks.slice(0, 100).flatMap(track => {
      try {
        const url = new URL(track.baseUrl);
        if (url.protocol !== 'https:' || !/(^|\.)youtube(?:-nocookie)?\.com$/.test(url.hostname) || url.pathname !== '/api/timedtext') return [];
        return [{ url: url.href, language: String(track.languageCode || '').slice(0, 30), label: String(track.name?.simpleText || track.name?.runs?.map(item => item.text || '').join('') || track.languageCode || 'YouTube 字幕').slice(0, 200) }];
      } catch { return []; }
    });
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== source || event.data?.type !== 'request' || typeof event.data?.nonce !== 'string' || event.data.nonce.length > 100) return;
    window.postMessage({ source, type: 'tracks', nonce: event.data.nonce, tracks: readTracks() }, location.origin);
  });
})();
