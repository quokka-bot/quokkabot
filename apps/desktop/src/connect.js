"use strict";
const form = document.querySelector("#connect-form");
const input = document.querySelector("#server-origin");
const button = document.querySelector("#connect-button");
const errorLabel = document.querySelector("#error");
const versionLabel = document.querySelector("#version");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  button.disabled = true;
  button.textContent = "Connecting…";
  errorLabel.textContent = "";
  try { await window.quokkabotConnect.connect(input.value.trim()); }
  catch (error) { errorLabel.textContent = error instanceof Error ? error.message : String(error); }
  finally { button.disabled = false; button.textContent = "Connect"; }
});
window.quokkabotConnect.getVersion().then((version) => { versionLabel.textContent = `Quokka Bot ${version}`; }).catch((error) => { errorLabel.textContent = String(error); });
