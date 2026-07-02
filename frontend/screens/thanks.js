// frontend/screens/thanks.js
// Shown after an interview ends and is scored. The report is no longer auto-opened —
// it's reached via the "View results" button here, or from the Progress page.
export function thanks(params){
  const id = params && params.id;
  const viewBtn = id
    ? '<a class="btn btn-green" style="text-decoration:none" href="#/session/' + encodeURIComponent(id) + '">View results</a>'
    : '';
  return '<div class="screen"><div class="thanks-wrap">' +
    '<div class="thanks-check">✓</div>' +
    '<h1>Thank you!</h1>' +
    '<p class="muted">Your interview is complete and your results are ready.</p>' +
    '<div class="thanks-actions">' +
      viewBtn +
      '<a class="btn btn-ghost" style="text-decoration:none" href="#/progress">See your progress</a>' +
      '<a class="btn btn-ghost" style="text-decoration:none" href="#/practice-interview">New practice interview</a>' +
    '</div>' +
  '</div></div>';
}
