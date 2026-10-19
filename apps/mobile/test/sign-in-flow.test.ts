import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { chooseServer, chosenLink, chosenServer, forgetChosenServer } from "../src/sign-in-flow";

const server = { origin: "https://bot.example.com", viewOrigin: "https://view.example.com" };
const link = { userCode: "ABCD-EFGH", pollToken: "p".repeat(43), verifyUrl: "https://bot.example.com/link#ABCD-EFGH", expiresAt: "2026-10-19T19:30:00.000Z" };

it("holds the server and link the server screen picked, until the phone signs in", () => {
  forgetChosenServer();
  expect(chosenServer()).toBeNull();
  expect(chosenLink()).toBeNull();
  chooseServer({ ...server, extra: "ignored" } as typeof server);
  expect(chosenServer()).toEqual(server);
  expect(chosenLink()).toBeNull();
  chooseServer(server, link);
  expect(chosenLink()).toEqual({ server, link });
  forgetChosenServer();
  expect(chosenServer()).toBeNull();
});

// A link from outside the app opens a screen with whatever route parameters it carries. The code and link screens
// must not read them: the server and the link come only from the server screen.
it.each(["app/(auth)/code.tsx", "app/(auth)/link.tsx"])("%s reads nothing from its route", (screen) => {
  const source = readFileSync(new URL(`../${screen}`, import.meta.url), "utf8");
  expect(source).not.toMatch(/use(Local|Global)SearchParams|params\./);
  expect(source).toMatch(/sign-in-flow/);
});
