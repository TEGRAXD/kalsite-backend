import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, notInArray, sql } from "drizzle-orm";
import { db, operators } from "../../database";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const OPERATOR_UPLOADS_DIR = resolve(
  __dirname,
  "../../../uploads/operators",
);

export const FACTION_UPLOADS_DIR = resolve(
  __dirname,
  "../../../uploads/factions",
);

const CAMPLOGO_FILENAME_OVERRIDES: Record<string, string> = {
  laterano: "logo_Laterano.png",
  leithanien: "logo_Leithanien.png",
};

export const ARKNIGHTS_RESOURCE_BASE = (
  process.env.ARKNIGHTS_RESOURCE_BASE_URL ||
  "https://raw.githubusercontent.com/fexli/ArknightsResource/main"
).replace(/\/+$/, "");

const NON_LATIN_SCRIPT_RE =
  /[\u0400-\u04FF\u0370-\u03FF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/;

const GENDER_MAP: Record<string, string> = {
  男: "Male",
  女: "Female",
  女士: "Female",
  自称雌性: "Self-identified Female",
  断罪: "Conviction",
  未知: "Unknown",
  未录入: "Unknown",
  未公开: "Undisclosed",
};

const RACE_MAP: Record<string, string> = {
  菲林: "Feline",
  黎博利: "Liberi",
  萨卡兹: "Sarkaz",
  佩洛: "Perro",
  沃尔珀: "Vulpo",
  阿戈尔: "Aegir",
  库兰塔: "Kuranta",
  鲁珀: "Lupo",
  乌萨斯: "Ursus",
  卡特斯: "Cautus",
  札拉克: "Zalak",
  卡普里尼: "Caprinae",
  萨科塔: "Sankta",
  斐迪亚: "Pythia",
  丰蹄: "Forte",
  埃拉菲亚: "Elafia",
  瓦伊凡: "Vouivre",
  鬼: "Oni",
  萨弗拉: "Savra",
  杜林: "Durin",
  阿纳缇: "Anaty",
  阿达克利斯: "Archosauria",
  龙: "Lung",
  德拉克: "Draco",
  瑞柏巴: "Reproba",
  阿斯兰: "Aslan",
  麒麟: "Kylin",
  精灵: "Elf",
  曼提柯: "Manticore",
  依特拉: "Itra",
  安努拉: "Anura",
  匹特拉姆: "Petram",
  "卡特斯/奇美拉": "Cautus / Chimera",
  皮洛萨: "Pilosa",
  塞拉托: "Cerato",
  阿纳萨: "Anasa",
  "长身人（自称）": "Tall-man",
  "半身人（自称）": "Halfling",
  "矮人（自称）": "Dwarf",
  "佩洛兽亲（据称）": "Perro",
  "未知（疑似黎博利）": "Unknown (Liberi?)",
  未公开: "Undisclosed",
  因经纪公司要求不公开: "Undisclosed",
  未知: "Unknown",
  未录入: "Unknown",
  不明: "Unknown",
};

interface HandbookOperatorMeta {
  releaseOrder: number;
  gender: string | null;
  race: string | null;
}

function parseHandbookGender(story: string): string | null {
  const match = story.match(/【(?:设定)?性别】\s*([^\n\r]+)/);
  if (!match) return null;
  const raw = match[1]!.trim();
  return GENDER_MAP[raw] ?? raw.slice(0, 30);
}

function parseHandbookRace(story: string): string | null {
  const match = story.match(/【种族】\s*([^\n\r]+)/);
  if (match) {
    const raw = match[1]!.trim();
    return RACE_MAP[raw] ?? raw.slice(0, 60);
  }
  if (/【(?:出厂|型号|产地)】/.test(story)) {
    return "Robot";
  }
  return null;
}

async function fetchHandbookMetaMap(): Promise<
  Record<string, HandbookOperatorMeta>
> {
  const url = `${ARKNIGHTS_RESOURCE_BASE}/gamedata/excel/handbook_info_table.json`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "kalsite-operator-sync" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return {};
    const data = (await res.json()) as {
      handbookDict?: Record<
        string,
        {
          storyTextAudio?: Array<{
            stories?: Array<{ storyText?: string }>;
          }>;
        }
      >;
    };
    const entries = Object.entries(data.handbookDict ?? {});
    const map: Record<string, HandbookOperatorMeta> = {};
    entries.forEach(([charId, entry], idx) => {
      const story = entry?.storyTextAudio?.[0]?.stories?.[0]?.storyText ?? "";
      map[charId] = {
        releaseOrder: idx + 1,
        gender: parseHandbookGender(story),
        race: parseHandbookRace(story),
      };
    });
    return map;
  } catch (err) {
    console.warn("[operators:sync] handbook_info_table fetch skipped:", err);
    return {};
  }
}

async function fetchHandbookTeamMap(): Promise<Record<string, string>> {
  const url = `${ARKNIGHTS_RESOURCE_BASE}/gamedata/excel/handbook_team_table.json`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "kalsite-operator-sync" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return {};
    const data = (await res.json()) as Record<
      string,
      { powerCode?: string; powerName?: string }
    >;
    const map: Record<string, string> = {};
    for (const [id, entry] of Object.entries(data)) {
      const label = (entry?.powerCode || entry?.powerName || "").trim();
      if (label && id !== "none") {
        map[id] = label;
      }
    }
    return map;
  } catch (err) {
    console.warn("[operators:sync] handbook_team_table fetch skipped:", err);
    return {};
  }
}

interface RawCharacter {
  name: string;
  appellation: string;
  rarity: number | string;
  profession: string;
  subProfessionId: string;
  isNotObtainable: boolean;
  nationId?: string | null;
  groupId?: string | null;
  teamId?: string | null;
  mainPower?: {
    nationId?: string | null;
    groupId?: string | null;
    teamId?: string | null;
  } | null;
}

export const PROFESSION_MAP: Record<string, string> = {
  PIONEER: "Vanguard",
  WARRIOR: "Guard",
  TANK: "Defender",
  SNIPER: "Sniper",
  CASTER: "Caster",
  MEDIC: "Medic",
  SUPPORT: "Supporter",
  SPECIAL: "Specialist",
};

export const BRANCH_MAP: Record<string, string> = {
  // Vanguard
  pioneer: "Pioneer",
  charger: "Charger",
  tactician: "Tactician",
  bearer: "Standard Bearer",
  agent: "Agent",
  // Guard
  centurion: "Centurion",
  fighter: "Fighter",
  artsfghter: "Arts Fighter",
  instructor: "Instructor",
  lord: "Lord",
  sword: "Swordmaster",
  musha: "Soloblade",
  fearless: "Dreadnought",
  reaper: "Reaper",
  librator: "Liberator",
  crusher: "Crusher",
  hammer: "Earthshaker",
  primguard: "Primal Guard",
  mercenary: "Mercenary",
  // Defender
  protector: "Protector",
  guardian: "Guardian",
  unyield: "Juggernaut",
  artsprotector: "Arts Protector",
  duelist: "Duelist",
  fortress: "Fortress",
  shotprotector: "Sentinel Protector",
  primprotector: "Primal Protector",
  // Sniper
  fastshot: "Marksman",
  closerange: "Heavyshooter",
  aoesniper: "Artilleryman",
  longrange: "Deadeye",
  reaperrange: "Spreadshooter",
  siegesniper: "Besieger",
  bombarder: "Flinger",
  hunter: "Hunter",
  loopshooter: "Loopshooter",
  skybreaker: "Skybreaker",
  // Caster
  corecaster: "Core Caster",
  splashcaster: "Splash Caster",
  funnel: "Mech-Accord Caster",
  phalanx: "Phalanx Caster",
  mystic: "Mystic Caster",
  chain: "Chain Caster",
  blastcaster: "Blast Caster",
  primcaster: "Primal Caster",
  soulcaster: "Shaper Caster",
  // Medic
  physician: "Medic",
  ringhealer: "Multi-target Medic",
  healer: "Therapist",
  wandermedic: "Wandering Medic",
  incantationmedic: "Incantation Medic",
  chainhealer: "Chain Medic",
  // Supporter
  slower: "Decel Binder",
  underminer: "Hexer",
  bard: "Bard",
  blessing: "Abjurer",
  summoner: "Summoner",
  craftsman: "Artificer",
  ritualist: "Ritualist",
  counsellor: "Strategist",
  watchman: "Watchman",
  dispatcher: "Dispatcher",
  supportiveranger: "Supportive Ranger",
  // Specialist
  executor: "Executor",
  pusher: "Push Stroker",
  stalker: "Ambusher",
  hookmaster: "Hookmaster",
  geek: "Geek",
  merchant: "Merchant",
  traper: "Trapmaster",
  dollkeeper: "Dollkeeper",
  alchemist: "Alchemist",
  skywalker: "Skyranger",
};

const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "yo",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

export function transliterateCyrillicToLatin(text: string): string {
  return text
    .split("")
    .map((ch) => {
      const lower = ch.toLowerCase();
      const mapped = CYRILLIC_TO_LATIN[lower];
      if (mapped === undefined) return ch;
      if (!mapped) return "";
      if (ch !== lower) {
        return mapped[0]!.toUpperCase() + mapped.slice(1);
      }
      return mapped;
    })
    .join("");
}

export function resolveLatinName(displayName: string): string | null {
  if (!NON_LATIN_SCRIPT_RE.test(displayName)) {
    return null;
  }

  const transliterated = transliterateCyrillicToLatin(displayName).trim();
  if (
    transliterated &&
    !NON_LATIN_SCRIPT_RE.test(transliterated) &&
    transliterated !== displayName
  ) {
    return transliterated.slice(0, 100);
  }

  return null;
}

export function parseRarity(raw: number | string): number {
  if (typeof raw === "number") {
    return Math.max(1, Math.min(6, raw + 1));
  }
  const match = String(raw).match(/(\d+)/);
  if (match) {
    const n = Number.parseInt(match[1]!, 10);
    return String(raw).toUpperCase().startsWith("TIER_")
      ? Math.max(1, Math.min(6, n))
      : Math.max(1, Math.min(6, n + 1));
  }
  return 1;
}

export function slugifyOperatorName(name: string, fallbackId = "op"): string {
  const transliterated = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ł/gi, "l")
    .replace(/²/g, "2")
    .toLowerCase()
    .split("")
    .map((ch) => CYRILLIC_TO_LATIN[ch] ?? ch)
    .join("");

  const slug = transliterated
    .replace(/['"`’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return (slug || fallbackId.toLowerCase().replace(/[^a-z0-9]+/g, "-")).slice(
    0,
    90,
  );
}

export function resolveBranchName(subProfessionId: string): string {
  const mapped = BRANCH_MAP[subProfessionId];
  if (mapped) return mapped;
  return subProfessionId
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

async function fileExistsNonEmpty(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

async function downloadFactionLogoToLocal(
  powerId: string,
  forceRedownload = false,
): Promise<string | null> {
  await mkdir(FACTION_UPLOADS_DIR, { recursive: true });
  const localFilename = `logo_${powerId.toLowerCase()}.png`;
  const targetPath = join(FACTION_UPLOADS_DIR, localFilename);

  if (!forceRedownload && (await fileExistsNonEmpty(targetPath))) {
    return `/uploads/factions/${localFilename}`;
  }

  const primaryRemote =
    CAMPLOGO_FILENAME_OVERRIDES[powerId.toLowerCase()] ?? `logo_${powerId}.png`;
  const capitalizedRemote = `logo_${powerId[0]!.toUpperCase()}${powerId.slice(1)}.png`;
  const candidates = Array.from(new Set([primaryRemote, capitalizedRemote]));

  for (const remoteName of candidates) {
    try {
      const res = await fetch(
        `${ARKNIGHTS_RESOURCE_BASE}/camplogo/${remoteName}`,
        {
          headers: { "User-Agent": "kalsite-operator-sync" },
        },
      );
      if (!res.ok) continue;
      const bytes = await res.arrayBuffer();
      if (bytes.byteLength === 0) continue;
      await Bun.write(targetPath, bytes);
      return `/uploads/factions/${localFilename}`;
    } catch {
      // try next candidate
    }
  }

  return null;
}

export async function downloadOperatorImageToLocal(
  remoteUrl: string,
  filename: string,
  forceRedownload = false,
): Promise<"downloaded" | "skipped" | "failed"> {
  await mkdir(OPERATOR_UPLOADS_DIR, { recursive: true });
  const targetPath = join(OPERATOR_UPLOADS_DIR, filename);

  if (!forceRedownload && (await fileExistsNonEmpty(targetPath))) {
    return "skipped";
  }

  try {
    const res = await fetch(remoteUrl, {
      headers: { "User-Agent": "kalsite-operator-sync" },
    });
    if (!res.ok) {
      return "failed";
    }
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength === 0) {
      return "failed";
    }
    await Bun.write(targetPath, bytes);
    return "downloaded";
  } catch {
    return "failed";
  }
}

export interface OperatorSyncSummary {
  source: string;
  totalFetched: number;
  inserted: number;
  updated: number;
  imagesDownloaded: number;
  imagesSkipped: number;
  imagesFailed: number;
  durationMs: number;
}

let activeSyncPromise: Promise<OperatorSyncSummary> | null = null;

export function syncOperatorsFromGitHub(options?: {
  forceRedownloadImages?: boolean;
}): Promise<OperatorSyncSummary> {
  if (activeSyncPromise) {
    return activeSyncPromise;
  }

  activeSyncPromise = runSyncOperatorsFromGitHub(options).finally(() => {
    activeSyncPromise = null;
  });
  return activeSyncPromise;
}

async function runSyncOperatorsFromGitHub(options?: {
  forceRedownloadImages?: boolean;
}): Promise<OperatorSyncSummary> {
  const startedAt = Date.now();
  const forceRedownload = Boolean(options?.forceRedownloadImages);

  const charTableUrl = `${ARKNIGHTS_RESOURCE_BASE}/gamedata/excel/character_table.json`;
  console.log(`[operators:sync] Fetching ${charTableUrl}...`);

  const [res, handbookMetaMap, teamMap] = await Promise.all([
    fetch(charTableUrl, {
      headers: { "User-Agent": "kalsite-operator-sync" },
    }),
    fetchHandbookMetaMap(),
    fetchHandbookTeamMap(),
  ]);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch character_table.json (${res.status} ${res.statusText})`,
    );
  }

  const charTable = (await res.json()) as Record<string, RawCharacter>;

  const playableEntries = Object.entries(charTable).filter(([charId, char]) => {
    if (!charId.startsWith("char_")) return false;
    if (char.isNotObtainable) return false;
    return Boolean(PROFESSION_MAP[char.profession]);
  });

  await mkdir(OPERATOR_UPLOADS_DIR, { recursive: true });
  await mkdir(FACTION_UPLOADS_DIR, { recursive: true });

  const uniquePowerIds = Array.from(
    new Set(
      playableEntries
        .map(([, char]) => {
          const powerId =
            char.mainPower?.nationId ||
            char.nationId ||
            char.mainPower?.groupId ||
            char.groupId ||
            char.mainPower?.teamId ||
            char.teamId ||
            null;
          return powerId && powerId !== "none" ? powerId : null;
        })
        .filter((id): id is string => Boolean(id)),
    ),
  );

  const factionLogoMap: Record<string, string> = {};
  await Promise.all(
    uniquePowerIds.map(async (powerId) => {
      const localUrl = await downloadFactionLogoToLocal(
        powerId,
        forceRedownload,
      );
      if (localUrl) {
        factionLogoMap[powerId] = localUrl;
      }
    }),
  );

  const usedSlugs = new Set<string>();
  const prepared = playableEntries.map(([charId, char]) => {
    const name = (char.appellation || char.name || charId).trim().slice(0, 100);
    const latinName = resolveLatinName(name);
    const cnName = (char.name || name).trim().slice(0, 100);
    let slug = slugifyOperatorName(latinName || name, charId);
    if (usedSlugs.has(slug)) {
      slug = `${slug}-${charId.replace(/^char_/, "")}`.slice(0, 100);
    }
    usedSlugs.add(slug);

    const powerId =
      char.mainPower?.nationId ||
      char.nationId ||
      char.mainPower?.groupId ||
      char.groupId ||
      char.mainPower?.teamId ||
      char.teamId ||
      null;
    const faction =
      powerId && powerId !== "none"
        ? (teamMap[powerId] ?? powerId).slice(0, 80)
        : null;
    const factionLogoUrl =
      powerId && powerId !== "none" ? (factionLogoMap[powerId] ?? null) : null;

    const filename = `${charId}.png`;
    return {
      row: {
        id: charId.slice(0, 36),
        name,
        latinName,
        cnName,
        slug,
        rarity: parseRarity(char.rarity),
        operatorClass: PROFESSION_MAP[char.profession]!,
        branch: resolveBranchName(char.subProfessionId).slice(0, 60),
        faction,
        factionLogoUrl,
        gender: handbookMetaMap[charId]?.gender ?? null,
        race: handbookMetaMap[charId]?.race ?? null,
        imageUrl: `/uploads/operators/${filename}`,
        releaseOrder: handbookMetaMap[charId]?.releaseOrder ?? null,
        isEnabled: true,
      },
      filename,
      remoteImageUrl: `${ARKNIGHTS_RESOURCE_BASE}/avatar/ASSISTANT/${filename}`,
    };
  });

  // Download operator avatar PNGs into our local uploads/operators folder in bounded batches
  let imagesDownloaded = 0;
  let imagesSkipped = 0;
  let imagesFailed = 0;
  const DOWNLOAD_CONCURRENCY = 16;

  for (let i = 0; i < prepared.length; i += DOWNLOAD_CONCURRENCY) {
    const chunk = prepared.slice(i, i + DOWNLOAD_CONCURRENCY);
    const results = await Promise.all(
      chunk.map((item) =>
        downloadOperatorImageToLocal(
          item.remoteImageUrl,
          item.filename,
          forceRedownload,
        ),
      ),
    );
    for (const status of results) {
      if (status === "downloaded") imagesDownloaded++;
      else if (status === "skipped") imagesSkipped++;
      else imagesFailed++;
    }
  }

  // Track existing IDs so we can report inserted vs updated accurately
  const existingRows = await db
    .select({ id: operators.id })
    .from(operators);
  const existingIds = new Set(existingRows.map((r) => r.id));

  let inserted = 0;
  let updated = 0;
  for (const item of prepared) {
    if (existingIds.has(item.row.id)) updated++;
    else inserted++;
  }

  // Batch upsert into PostgreSQL
  const BATCH_SIZE = 50;
  for (let i = 0; i < prepared.length; i += BATCH_SIZE) {
    const batch = prepared.slice(i, i + BATCH_SIZE).map((p) => p.row);
    await db
      .insert(operators)
      .values(batch)
      .onConflictDoUpdate({
        target: operators.id,
        set: {
          name: sql`excluded.name`,
          latinName: sql`excluded.latin_name`,
          cnName: sql`excluded.cn_name`,
          slug: sql`excluded.slug`,
          rarity: sql`excluded.rarity`,
          operatorClass: sql`excluded.class`,
          branch: sql`excluded.branch`,
          faction: sql`COALESCE(excluded.faction, ${operators.faction})`,
          factionLogoUrl: sql`COALESCE(excluded.faction_logo_url, ${operators.factionLogoUrl})`,
          gender: sql`COALESCE(excluded.gender, ${operators.gender})`,
          race: sql`COALESCE(excluded.race, ${operators.race})`,
          imageUrl: sql`excluded.image_url`,
          releaseOrder: sql`COALESCE(excluded.release_order, ${operators.releaseOrder})`,
          isEnabled: true,
        },
      });
  }

  // Disable stale GitHub-synced entries no longer in character_table (preserve manual_* entries)
  const syncedSlugs = prepared.map((p) => p.row.slug);
  if (syncedSlugs.length > 0) {
    await db
      .update(operators)
      .set({ isEnabled: false })
      .where(
        sql`${notInArray(operators.slug, syncedSlugs)} AND ${operators.id} NOT LIKE 'manual_%'`,
      );
  }

  const summary: OperatorSyncSummary = {
    source: charTableUrl,
    totalFetched: prepared.length,
    inserted,
    updated,
    imagesDownloaded,
    imagesSkipped,
    imagesFailed,
    durationMs: Date.now() - startedAt,
  };

  console.log(
    `[operators:sync] Done in ${summary.durationMs}ms: ${summary.totalFetched} ops (${summary.inserted} new, ${summary.updated} updated), images: ${summary.imagesDownloaded} downloaded, ${summary.imagesSkipped} cached, ${summary.imagesFailed} failed.`,
  );

  return summary;
}

export async function saveManualOperatorImage(
  file: File,
  slug: string,
): Promise<string> {
  await mkdir(OPERATOR_UPLOADS_DIR, { recursive: true });
  const extMatch = file.name.toLowerCase().match(/\.(png|jpg|jpeg|webp)$/);
  const ext = extMatch ? extMatch[1] : "png";
  const safeSlug = slug.replace(/[^a-z0-9_-]/gi, "-").slice(0, 64) || "operator";
  const filename = `manual_${safeSlug}_${Date.now()}.${ext}`;
  const targetPath = join(OPERATOR_UPLOADS_DIR, filename);
  await Bun.write(targetPath, await file.arrayBuffer());
  return `/uploads/operators/${filename}`;
}

export async function ensureManualOperatorNotDisabled(id: string) {
  await db
    .update(operators)
    .set({ isEnabled: true })
    .where(eq(operators.id, id));
}
