"""Seed Cloudflare KV with recovered targets and stances."""
import subprocess, json, sys

KV_NAMESPACE_ID = "ad6cb6f820074d61bb990a9e2fe8875d"
WRANGLER_DIR = r"C:\Users\DELL\bookmark-cli\telegram-bot"

TARGETS = [
    # Tech / founders / builders
    "levelsio", "swyx", "paulg", "naval", "_zeets", "karpathy", "sama",
    "gergelyorosz", "theprimeagen", "t3dotgg", "shreyas", "david_perell",
    "morganhousel", "emollick", "justinkan", "lennysan", "patrickc", "jasonlk",
    "ylecun", "drjimfan", "fortelabs", "lethain", "kelseyhightower", "rakyll",
    "simonw", "freecodecamp", "mkbhd", "laurieontech", "hacksultan", "techgirl1908",
    # Nigerian voices
    "davidhundeyin", "delefarotimi", "peterobi", "elnathan_john", "ikhide",
    "the_acumen", "doctoratlarge", "theoddsolace", "mrmacaroni", "larrymadowo",
    "asemota", "cchukudebelu", "ourfavonlinedoc", "ruggedyenagoa",
    "akinwunmi_ambode", "abati_olusegun", "laurettaonochie", "fkeyamo",
    "finplankaluaja1", "olumidecapital",
    # Football / LFC
    "fabrizioromano", "david_ornstein", "jamespearcelfc", "theanfieldwrap",
    "mikehugheslfc", "lfctransferroom", "lfc", "premierleague", "brfootball",
    "taintlessred", "janaagehansen", "gary_lineker", "neville_official",
    "morris_monye",
    # Culture / media
    "mattwalshblog", "whotfismick", "sonofalli", "hashjenni", "discussingfilm",
    "bigsnugga", "theereal_one", "kirawontmiss", "soverybritish", "treydayway",
    "piersmorgan",
]

STANCES = {
    # Liverpool / football
    "liverpool": (
        "Slot is exposed in year 2. Won the title on Klopp's squad. "
        "Football has gotten worse with largely the same players. "
        "Board excused for now but next season is the real test."
    ),
    "liverpool slot premier league": (
        "Slot won the title on a Klopp inheritance but has since shown his ceiling. "
        "4th in the table, tactically passive, and the PSG performance exposed a manager "
        "who doesn't believe his team can win the big ones. "
        "The title was a peak, not a baseline — and the decline since is on him."
    ),
    "slot": (
        "Slot won the title riding on Klopp's squad and aura. "
        "The cracks were visible even when winning. "
        "Second season has exposed him — the football has gotten worse with largely "
        "the same players. He is not the right man for the job long term."
    ),
    "jurgen klopp liverpool legend": (
        "Klopp is the greatest thing to happen to Liverpool in my lifetime as a fan. "
        "He walked in and said 'I want to turn doubters into believers' and delivered "
        "every trophy possible. His relationship with the city and the fans was special. "
        "Standards he set are the ones Slot is failing to meet."
    ),
    "salah liverpool generational": (
        "Salah is generational. The most consistent player this club has had since Gerrard. "
        "Carried the title almost single handed last season, won every individual award going. "
        "He didn't decline — he was mismanaged. Letting him leave would be a grave mistake "
        "and whoever let him get to the last year of his contract needs to answer for it."
    ),
    "manchester united fans rivals": (
        "Manchester United are Liverpool's most important rivalry and I want them beaten "
        "every single time we meet — no exceptions, no moral victories, no 'good performance "
        "in defeat.' Carrick is their manager. The fact that Slot lost to them recently is "
        "one of the biggest stains on his record."
    ),
    "arsenal premier league": (
        "Arsenal are a Liverpool rival and I do not want them winning any trophies. "
        "They play dark arts football — time-wasting, simulation, and cynical fouling. "
        "Their fans are deplorable. Arteta is a narcissist — the opposite of Wenger. "
        "I used to respect them under Wenger. That era is gone."
    ),
    # Nigerian politics
    "nigeria politics tinubu governance": (
        "Tinubu is a corrupt, self-serving political operator who uses intimidation and "
        "ethnic patronage networks to consolidate power, not govern. His Lagos model — "
        "feudalistic resource capture and clientelism — is being scaled nationally, "
        "making his presidency an existential threat to Nigeria."
    ),
    "apc tinubu ruling party": (
        "Tinubu and the APC are corrupt, manipulative forces that use intimidation, "
        "political scheming, and party infiltration to crush opposition and maintain power. "
        "Tinubu's political legacy is one of damage — he helped bring Buhari to power and "
        "continues to be the biggest threat to Nigerian democracy."
    ),
    "naira economy hardship nigeria": (
        "Tinubu's borrowing is unprecedented — Nigeria's debt has risen sharply, the naira "
        "is at its weakest, oil output is low, and governors have gotten richer while "
        "ordinary citizens face untold hardship. The fuel subsidy removal was a betrayal "
        "that crushed the poor while the elite continued looting. "
        "This is economic mismanagement by design."
    ),
    "fuel subsidy removal nigeria poor": (
        "The fuel subsidy removal in Nigeria was a betrayal of ordinary citizens — "
        "it crushed the poor while corrupt politicians continued to enrich themselves, "
        "rendering the policy's stated justifications hollow. "
        "The real problem was never the subsidy itself but the corruption underneath it."
    ),
    "peter obi nigeria opposition": (
        "Peter Obi is the best hope for transforming Nigeria, and I fully support his candidacy. "
        "He represents a break from corrupt, old-guard politics and embodies what Nigeria could become. "
        "The opposition to him is rooted in the same broken system he threatens to dismantle."
    ),
    "peter obi labour adc coalition": (
        "I am a strong Peter Obi supporter who believes in his leadership and vision for Nigeria. "
        "A Labour Party-ADC coalition makes sense as a strategic move to strengthen his "
        "political viability and broaden his reach. Obi remains my preferred candidate regardless "
        "of which platform he runs on."
    ),
    "atiku abubakar adc 2027": (
        "I support Peter Obi as the rightful presidential candidate for 2027 and reject any "
        "arrangement that reduces him to a running mate under Atiku. "
        "Atiku is too old, politically maneuvering, and would weaken the coalition's chances "
        "against Tinubu — the ADC's strength comes from Obi leading it, not Atiku."
    ),
    "nigeria adc opposition 2027": (
        "Cautiously hopeful but clear-eyed about the ADC coalition's potential for 2027. "
        "The Obi-Kwankwaso alignment is worth watching but translating 2023 votes into "
        "actual seats requires structural reform and voter mobilization that hasn't happened yet."
    ),
    "efcc nigeria toothless": (
        "The EFCC is a political weapon, not a law enforcement agency. "
        "It selectively targets opposition figures and poor youth scapegoats while turning "
        "a blind eye to APC-connected looters. The EFCC chairman was appointed by Tinubu himself "
        "— the most corrupt administration since the republic was created."
    ),
    "nigeria security bandits terrorism north": (
        "Nigeria's security apparatus is deliberately broken — it protects the regime and "
        "selectively targets critics while enabling bandits and terrorists in the North to "
        "operate with impunity. The problem is a corrupt political class, not a North vs South divide."
    ),
    "nigeria": (
        "Nigeria is a failed state — politically corrupt, economically mismanaged, and hostile "
        "to its own people. The country's problems are self-inflicted through reckless governance "
        "and elite capture, not a lack of resources. "
        "The best Nigerians can do is build something that doesn't depend on the state."
    ),
    # Tech / AI
    "ai": (
        "AI is a genuinely useful, practical tool that I actively use in my software development "
        "workflow. It's essentially a supercharged autocomplete — powerful for coding and "
        "refactoring, but not capable of generating truly new ideas. "
        "The hype vastly outpaces the reality."
    ),
    "ai jobs automation future work": (
        "AI won't eliminate jobs but will fundamentally transform how work gets done, especially "
        "in software engineering. Professionals who embrace AI as a productivity multiplier will "
        "vastly outperform those who don't — making adoption a career necessity, not a choice."
    ),
    "startup founder building saas": (
        "Building a SaaS is romanticized way too much — the technical side is the easy part, "
        "and most people underestimate that distribution, customers, and business fundamentals "
        "are what actually determine success. The market is crowded and competition should be "
        "your first concern, not the stack."
    ),
    # Finance / lifestyle
    "crypto bitcoin future": (
        "I'm fascinated by Bitcoin and crypto but approach it with cautious skepticism. "
        "I see real long-term potential — especially as institutional adoption grows — "
        "but I take the volatility, regulatory risks, and societal risks seriously. "
        "Never bet more than I can afford to lose."
    ),
    "investing wealth passive income": (
        "Wealth building is about understanding the distinction between income, savings, and "
        "actual investing — and putting money to work through capital markets and passive "
        "income streams rather than chasing status symbols or lifestyle inflation."
    ),
    "content creator social media": (
        "Content creation is a legitimate and growing path worth taking seriously. "
        "The right tools, a clear personal brand, and community support separate creators "
        "who break through from those who don't."
    ),
    "relationships dating marriage": (
        "I date with marriage as the clear end goal and have no patience for casual situationships. "
        "Having your life together raises your standards and makes finding a compatible "
        "partner harder, but that's the price of discipline."
    ),
}


def kv_put(key, value_json):
    import tempfile, os
    # Write value to a temp file to avoid command-line length limits
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False, encoding="utf-8") as f:
        f.write(value_json)
        tmp = f.name
    try:
        tmp_fwd = tmp.replace("\\", "/")
        cmd = (
            f'npx wrangler kv key put --namespace-id {KV_NAMESPACE_ID}'
            f' --remote "{key}" --path "{tmp_fwd}"'
        )
        result = subprocess.run(
            cmd, cwd=WRANGLER_DIR, capture_output=True, text=True,
            shell=True, encoding="utf-8", errors="replace",
        )
    finally:
        os.unlink(tmp)
    if result.returncode != 0:
        print(f"  FAILED: {result.stderr[:200]}", file=sys.stderr)
        return False
    return True


def main():
    print(f"Seeding {len(TARGETS)} targets...")
    ok = kv_put("targets", json.dumps(TARGETS))
    print(f"  {'OK' if ok else 'FAIL'} targets ({len(TARGETS)} accounts)")

    print(f"\nSeeding {len(STANCES)} stances...")
    ok = kv_put("__stances", json.dumps(STANCES))
    print(f"  {'OK' if ok else 'FAIL'} stances ({len(STANCES)} topics)")

    print("\nSeeding empty winners and drafts...")
    ok1 = kv_put("__winners", json.dumps([]))
    ok2 = kv_put("__drafts", json.dumps([]))
    print(f"  OK winners  OK drafts")

    print("\nDone. Verify with /status or /targets in Telegram.")


if __name__ == "__main__":
    main()
