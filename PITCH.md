# Laetoli — A Sovereign Technology Stack for East Africa

*Funder & partner brief · Laetoli Ltd · 2026*

---

## Muhtasari (Kiswahili)

Laetoli ni kampuni ya teknolojia ya Kitanzania inayojenga **uhuru wa kidijitali**:
miundombinu ya programu inayomilikiwa na Waafrika, inayofanya kazi kwa Kiswahili,
na inayofundisha kizazi kijacho kujenga teknolojia kwa lugha yake.

Tunajenga mambo matatu yanayoshikana:

1. **SNIL** — lugha ya kwanza ya programu yenye asili ya Kiafrika. Ina sarufi yake
   na maneno-msingi ya Kiswahili; inakimbia ndani ya kivinjari na inaweza
   ku-*compile* kwenda Python na JavaScript. *(Hai: https://snil.vercel.app)*
2. **Laetoli Data** — *backend* huru unaojiendesha mwenyewe (Postgres + PostgREST +
   *auth* + SDK), unaofanya kazi kwenye seva ya Tanzania au hata **Raspberry Pi** —
   "shule ndani ya kisanduku", bila ada za kila mwezi za kampuni za nje.
3. **Elimu** — DARASA (kozi ya SNIL) na zana zinazowafundisha vijana kujenga
   programu kwa Kiswahili — bila kizuizi cha lugha ya kigeni.

Tunaomba **ufadhili wa kiwango cha $10M** ili kukuza injinia, mtaala, na matumizi
halisi mashuleni na serikalini Afrika Mashariki. Yote ni *open-source* (Apache-2.0).

---

## The problem

Two dependencies quietly exclude most Africans from building digital technology:

- **A foreign-language barrier.** Every mainstream programming language assumes
  fluency in English. A teenager in Dodoma who reasons fluently in Kiswahili must
  first cross a language wall before they can write a single line of code. The
  barrier is not talent — it is vocabulary.
- **A foreign-SaaS dependency.** The default way to ship software today routes a
  nation's data through foreign cloud platforms, priced in dollars, governed by
  foreign terms, and billed per project forever. For schools, startups, and
  ministries operating in shillings, this is both a sovereignty risk and a
  recurring cost that compounds.

The result: African builders rent their tools and host their data abroad, and the
next generation learns to build in someone else's language, on someone else's
infrastructure. Digital participation becomes a subscription, not a capability.

## The vision — a sovereign stack

Laetoli's thesis is simple: **own the language, own the data infrastructure, and
teach the next generation to build in their own tongue — all open and affordable.**

Sovereignty here is concrete, not slogan:

- **Linguistic sovereignty** — a programming language whose keywords, grammar, and
  error messages are Kiswahili, so the language is a bridge, not a barrier.
- **Data sovereignty** — a backend you can run on your own hardware, in-country or
  offline, so your data stays under your law and your roof.
- **Educational sovereignty** — curriculum that lets a Kiswahili speaker go from
  zero to building real software without first mastering English.

## What exists today

These are shipped, working systems — not concepts. Status is marked honestly.

### SNIL — Swahili Native Intent Language
*The first African-origin programming language.*

- A language built from the ground up for Kiswahili speakers: **its own grammar,
  Kiswahili keywords, and Kiswahili error messages** — not a translation layer over
  Python.
- **Dual execution:** runs in-browser via an interpreter (zero install) *and*
  compiles to **Python** (primary target) and **JavaScript**, so the same program
  can teach in a playground and ship as real software.
- Ships with a **DARASA** step-by-step course, a **REPL**, modules/standard
  library, a **VS Code extension** for `.snil` syntax highlighting, and a PWA.
- Governed openly: published **CONSTITUTION**, **GOVERNANCE**, **GRAMMAR**, and
  **SECURITY** documents in the repo.
- **Live:** https://snil.vercel.app · Repo: `nooher/snil` · Engine also packaged as
  **`@laetoli/snil`** (`nooher/snil-core`) · **Apache-2.0**.

### Laetoli Data — sovereign self-hostable backend
*Own your data; stop paying per-project SaaS fees.*

- Assembles the **proven open stack — PostgreSQL + PostgREST** — plus a lean
  sovereign **auth** service and a **`@laetoli/data`** client SDK that is a near
  drop-in for the subset of the Supabase JS client our apps use
  (`from().select/insert/update/delete`, `auth.signUp/signInWithPassword/
  signInAnonymously`, etc.). Existing Row-Level-Security migrations port directly
  because the JWT claim model (`sub`, `role`) matches.
- Runs anywhere via Docker Compose (Postgres + PostgREST + Auth + Caddy/TLS) — on a
  **Tanzanian VPS** or a **Raspberry Pi in a classroom with no internet**
  ("shule ndani ya kisanduku" / school in a box).
- **Verified end-to-end** (proof-of-concept and component tests in the repo).
- Repo: this repository · **Apache-2.0**. Deployment and Pi guides included
  (`DEPLOY.md`, `RASPBERRY_PI.md`).

### The broader ecosystem (already built by Laetoli)
Laetoli has shipped a family of Swahili-first, government-grade platforms and
consumer apps that prove the team can deliver production systems, not just tooling:

- **THOS** — a national health interoperability operating system.
- **TISEZA** — a digital twin for Special Economic Zones.
- **TANROADS** — a road-reserve asset management platform.
- **IRMP** — an intellectual-property rights management platform.
- **Tiba** health apps and **Kasuku** (African literature & streaming).
- **LaetoliHub** — the umbrella at **laetoli.tz**.

> Honest framing: the government-grade platforms above are working demonstrators
> and prototypes built to bid-readiness; several integrations with national systems
> are deliberately deferred until procurement. We present them as **proof of
> delivery capacity**, not as live national deployments.

## Why now

- **A demographic dividend.** East Africa's population is overwhelmingly young, with
  Kiswahili as a shared working language across more than 100 million speakers —
  the largest market on earth for a Kiswahili-native developer toolchain.
- **Sovereignty is now policy.** Governments across Africa are actively pursuing
  data localization, digital public infrastructure (DPI), and local-capacity
  mandates. An open, self-hostable, in-language stack is exactly what those
  policies call for.
- **The tooling is finally feasible.** Browser-based interpreters, lightweight
  single-board computers, and the mature Postgres/PostgREST ecosystem make a
  fully sovereign, offline-capable stack practical for the first time — and Laetoli
  has already built it.

## Impact

- **Education access** — DARASA lets Kiswahili speakers learn to program without an
  English prerequisite; Laetoli Data on a Raspberry Pi brings a full backend to
  classrooms with no connectivity.
- **Digital & data sovereignty** — institutions own their data, in-country, under
  their own law.
- **Cost savings vs. SaaS** — replacing per-project foreign cloud subscriptions
  with self-hosted infrastructure converts a recurring dollar cost into a one-time,
  locally-serviced asset.
- **Local jobs & capacity** — training in-language builders and local support/
  hosting partners keeps the value chain inside the region.
- **Aligned to the SDGs** — Quality Education (SDG 4), Decent Work & Economic Growth
  (SDG 8), Industry, Innovation & Infrastructure (SDG 9), and Reduced Inequalities
  (SDG 10).

## Business & sustainability model — open core

Everything core is open-source (Apache-2.0). Sustainability comes from services
around the open core, not from licensing the code:

- **Support & hosting** — managed Laetoli Data deployments, SLAs, and maintenance
  for ministries, schools, and businesses that want the sovereignty without the ops.
- **Education** — DARASA curriculum, teacher training, certification, and
  "school-in-a-box" Raspberry Pi kits.
- **Integration & solutions** — adapting the government-grade platforms (THOS,
  IRMP, TISEZA, TANROADS) to specific national deployments.

This keeps the public goods free and open while funding the team that maintains them.

## The ask

We are raising **$10M-scale catalytic funding** (grant and/or blended) to move from
shipped technology to national-scale adoption. Illustrative use of funds:

| Area | Share | What it buys |
| --- | --- | --- |
| **Engineering** | ~35% | Harden SNIL & Laetoli Data for production scale; expand the standard library, compiler targets, and SDK; security and accessibility. |
| **Curriculum & education** | ~25% | DARASA expansion, teacher training, certification, and Raspberry Pi "school-in-a-box" kits for pilot schools. |
| **Deployments** | ~20% | Reference deployments with schools and ministries; offline/low-connectivity field kits and support. |
| **Partnerships & ecosystem** | ~10% | Standards bodies, universities, government MoUs, developer community. |
| **Operations & sustainability** | ~10% | Team, governance, and the open-source maintenance that keeps the stack a durable public good. |

## Target funders & partners

- **Education & culture** — UNESCO; Mastercard Foundation.
- **Digital development** — GIZ / **FAIR Forward** (AI & open data for all),
  Bill & Melinda Gates Foundation (DPI / digital public goods).
- **Development finance** — World Bank, African Development Bank (AfDB).
- **Government** — Tanzanian and East African **Ministries of Education and ICT**;
  national e-government and data-protection authorities.

## Team

- **Dr. Ally Abdul Nooher — Chief Health & Innovation Officer (CHIO).** Clinician
  and engineer; architect of Laetoli's sovereign health and reasoning systems.
- **Azizi Chamani — Chief Executive Officer (CEO).** Leads strategy, partnerships,
  and growth.
- **Rainhard Ngambiye — Chief Technology Officer (CTO).** Leads platform
  engineering across the Laetoli stack.

Track record: a shipped programming language, a working sovereign backend, and a
portfolio of government-grade Swahili-first platforms — delivered as a small,
focused team.

## Call to action

Africa should not have to rent its language or its data. Laetoli has already built
the proof — an African programming language, a sovereign backend, and the
curriculum to teach with both. With catalytic funding, we take it from working
technology to a generation of builders.

**Let's build the sovereign digital foundation for East Africa — together.**

*Contact: Laetoli Ltd · laetoli.tz · hello@laetoli.africa · Apache-2.0, open to all.*
