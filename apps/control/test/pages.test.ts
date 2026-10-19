import { expect, it } from "vitest";
import { privacyPage } from "../src/pages.js";

// The server's privacy page is what Google's consent screen links to; it must match what the code does.
it("names the AI provider, keeps the Google Limited Use statement and links to the full policy", () => {
  const page = privacyPage("https://bot.example.com", null);
  expect(page).toContain("Anthropic receives what the agent works with");
  expect(page).toContain("never reach the model");
  expect(page).toContain("https://developers.google.com/terms/api-services-user-data-policy");
  expect(page).toContain("Limited Use");
  expect(page).toContain("The refresh token is stored encrypted");
  expect(page).toContain('href="https://quokkabot.com/privacy"');
  expect(page).not.toContain("stay on this server");
});

it("shows the contact address escaped and leaves the section out without one", () => {
  expect(privacyPage("https://bot.example.com", 'owner@example.com"><script>')).toContain("owner@example.com&#34;&#62;&#60;script&#62;");
  expect(privacyPage("https://bot.example.com", null)).not.toContain("<h2>Contact</h2>");
});
