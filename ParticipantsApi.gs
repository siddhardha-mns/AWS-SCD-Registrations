/**
 * Retirement endpoint for the former public participant export.
 * Redeploy this file ONLY in the old export project to disable that endpoint.
 * Do not add it to the portal project: Code.gs owns its doGet/doPost handlers.
 */
function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ok:false,error:'Participant export disabled. Use the authenticated portal bridge.'})).setMimeType(ContentService.MimeType.JSON);
}
