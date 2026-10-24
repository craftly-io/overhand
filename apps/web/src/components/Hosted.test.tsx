import { expect, test } from "bun:test";
import { plainWords } from "@overhand/themes";
import { renderToStaticMarkup } from "react-dom/server";
import { HostedPublic } from "./Hosted";

const eur = (amount: number) => ({ amount, currency: "EUR" });

test("signed out, the hosted page shows what Overhand is, the plans with live prices, the policies and Sign in", () => {
  const html = renderToStaticMarkup(
    <HostedPublic
      w={plainWords}
      prices={{ pro: { month: eur(900), year: eur(9000) }, team: { month: eur(1200), year: eur(12000) } }}
      onSignIn={() => {}}
    />,
  );
  for (const want of [
    plainWords.hostedPublicLine,
    "Pro",
    "Team",
    "€9 / month",
    "€90 / year",
    "€12 per seat / month",
    "€120 per seat / year",
    "Sign in",
  ])
    expect(html).toContain(want);
  for (const page of ["terms", "privacy", "refund", "contact"]) expect(html).toContain(`href="https://overhand.dev/${page}"`);
  expect(html).toContain('href="https://overhand.dev"');
  expect(html.toLowerCase()).not.toContain("dashboard");
});

test("when prices can't be read, it points at the site's pricing page", () => {
  const html = renderToStaticMarkup(<HostedPublic w={plainWords} prices={null} onSignIn={() => {}} />);
  expect(html).toContain('href="https://overhand.dev/pricing"');
  expect(html).toContain(plainWords.hostedPricesElsewhere);
});
