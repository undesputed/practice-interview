// Builds a Clean Studio placeholder screen. Replaced per-screen in later phases.
export function placeholder(title, note){
  return (params) => {
    const idSuffix = params && params.id ? ' · ' + params.id : '';
    return '' +
      '<div class="screen">' +
        '<div class="screen-head"><h1>' + title + idSuffix + '</h1></div>' +
        '<div class="placeholder-card">' +
          '<p>' + note + '</p>' +
          '<p class="muted">Placeholder — this screen is built in a later phase.</p>' +
        '</div>' +
      '</div>';
  };
}
