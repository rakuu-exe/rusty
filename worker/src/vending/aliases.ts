/**
 * Community names for Rust items.
 *
 * Nobody types "Timed Explosive Charge" into a vending search; they type "c4".
 * Without these, the plain text search either misses entirely or ranks the
 * wrong thing first — "semi" hits "Semi Automatic Body" before either weapon.
 *
 * Values are **short names**, not display names. Facepunch renames items
 * (this data set alone had 'Work Bench Level 1' become 'Workbench Level 1',
 * and 'Reinforced Glass Window' move to a different item entirely), and a
 * table keyed on display names would rot silently. Short names are the game's
 * own stable identifiers.
 *
 * Keys must be pre-normalised: lower case, alphanumerics only, since that is
 * what the lookup compares against. So "5.56" is written "556" and "MP5A4"
 * as "mp5a4".
 */

export const ITEM_ALIASES: Readonly<Record<string, string>> = {
  // ---- guns --------------------------------------------------------------
  ak: 'rifle.ak',
  ak47: 'rifle.ak',
  lr: 'rifle.lr300',
  lr300: 'rifle.lr300',
  sar: 'rifle.semiauto',
  semirifle: 'rifle.semiauto',
  /**
   * "Semi" is used for both the rifle and the pistol. The rifle is the more
   * common reading, and the pistol has its own unambiguous alias in "p2".
   */
  semi: 'rifle.semiauto',
  p2: 'pistol.semiauto',
  sap: 'pistol.semiauto',
  semipistol: 'pistol.semiauto',
  tommy: 'smg.thompson',
  thommy: 'smg.thompson',
  mp5: 'smg.mp5',
  mp5a4: 'smg.mp5',
  custom: 'smg.2',
  customsmg: 'smg.2',
  m2: 'lmg.m249',
  249: 'lmg.m249',
  m249: 'lmg.m249',
  lmg: 'hmlmg',
  bolty: 'rifle.bolt',
  bolt: 'rifle.bolt',
  l96: 'rifle.l96',
  l9: 'rifle.l96',
  m39: 'rifle.m39',
  python: 'pistol.python',
  revo: 'pistol.revolver',
  revy: 'pistol.revolver',
  proto: 'pistol.prototype17',
  prototype: 'pistol.prototype17',
  m92: 'pistol.m92',
  militarypistol: 'pistol.m92',
  nails: 'pistol.nailgun',
  eoka: 'pistol.eoka',
  pipe: 'shotgun.waterpipe',
  pipey: 'shotgun.waterpipe',
  waterpipe: 'shotgun.waterpipe',
  db: 'shotgun.double',
  doublebarrel: 'shotgun.double',
  pump: 'shotgun.pump',
  spas: 'shotgun.spas12',
  spas12: 'shotgun.spas12',
  rl: 'rocket.launcher',
  gl: 'multiplegrenadelauncher',
  grenadelauncher: 'multiplegrenadelauncher',
  compound: 'bow.compound',
  bow: 'bow.hunting',
  crossy: 'crossbow',
  woodspear: 'spear.wooden',
  stonespear: 'spear.stone',
  sword: 'salvaged.sword',
  cleaver: 'salvaged.cleaver',

  // ---- explosives --------------------------------------------------------
  c4: 'explosive.timed',
  satchel: 'explosive.satchel',
  satty: 'explosive.satchel',
  beancan: 'grenade.beancan',
  f1: 'grenade.f1',
  hv: 'ammo.rocket.hv',
  incenrocket: 'ammo.rocket.fire',
  rocket: 'ammo.rocket.basic',
  herocket: 'ammo.rocket.basic',
  smokerocket: 'ammo.rocket.smoke',

  // ---- ammo --------------------------------------------------------------
  556: 'ammo.rifle',
  hvammo: 'ammo.rifle.hv',
  exploammo: 'ammo.rifle.explosive',
  incenammo: 'ammo.rifle.incendiary',
  pistolammo: 'ammo.pistol',
  hvpistol: 'ammo.pistol.hv',
  incenpistol: 'ammo.pistol.fire',
  buck: 'ammo.shotgun',
  buckshot: 'ammo.shotgun',
  slug: 'ammo.shotgun.slug',

  // ---- armour ------------------------------------------------------------
  hazzy: 'hazmatsuit',
  hazmat: 'hazmatsuit',
  arctichazzy: 'hazmatsuit.arcticsuit',
  bluehazzy: 'hazmatsuit.arcticsuit',
  /** The "heavy set" is three pieces; the helmet is the one people mean. */
  heavyset: 'heavy.plate.helmet',
  metalmask: 'metal.facemask',
  facemask: 'metal.facemask',
  coffeecan: 'coffeecan.helmet',
  roadsignjacket: 'roadsign.jacket',
  roadsignkilt: 'roadsign.kilt',

  // ---- deployables -------------------------------------------------------
  tc: 'cupboard.tool',
  turret: 'autoturret',
  sam: 'samsite',
  shotguntrap: 'guntrap',
  box: 'box.wooden.large',
  largebox: 'box.wooden.large',
  smallbox: 'box.wooden',

  // ---- doors -------------------------------------------------------------
  sheetdoor: 'door.hinged.metal',
  garage: 'wall.frame.garagedoor',
  armored: 'door.hinged.toptier',
  wooddoor: 'door.hinged.wood',

  // ---- components --------------------------------------------------------
  spring: 'metalspring',
  smgbody: 'smgbody',
  semibody: 'semibody',
  riflebody: 'riflebody',
  techtrash: 'techparts',
  camera: 'cctv.camera',
  targetingcomputer: 'targeting.computer',

  // ---- resources ---------------------------------------------------------
  hqm: 'metal.refined',
  frags: 'metal.fragments',
  gp: 'gunpowder',
  lgf: 'lowgradefuel',
  lowgrade: 'lowgradefuel',
  crude: 'crude.oil',

  // ---- workbenches -------------------------------------------------------
  t1: 'workbench1',
  tier1: 'workbench1',
  wb1: 'workbench1',
  workbench1: 'workbench1',
  level1: 'workbench1',
  t2: 'workbench2',
  tier2: 'workbench2',
  wb2: 'workbench2',
  workbench2: 'workbench2',
  level2: 'workbench2',
  t3: 'workbench3',
  tier3: 'workbench3',
  wb3: 'workbench3',
  workbench3: 'workbench3',
  level3: 'workbench3',

  // ---- blueprint fragments -----------------------------------------------
  basic: 'basicblueprintfragment',
  basicbp: 'basicblueprintfragment',
  basicbpfrag: 'basicblueprintfragment',
  basicfrag: 'basicblueprintfragment',
  bpfrag: 'basicblueprintfragment',
  bpfrags: 'basicblueprintfragment',
  blueprintfragment: 'basicblueprintfragment',
  basicblueprint: 'basicblueprintfragment',
  t2fragment: 'basicblueprintfragment',
  t2bp: 'basicblueprintfragment',
  advanced: 'advancedblueprintfragment',
  adv: 'advancedblueprintfragment',
  advbp: 'advancedblueprintfragment',
  advancedbp: 'advancedblueprintfragment',
  advancedfrag: 'advancedblueprintfragment',
  advfrag: 'advancedblueprintfragment',
  advancedbpfrag: 'advancedblueprintfragment',
  t3fragment: 'advancedblueprintfragment',
  t3bp: 'advancedblueprintfragment',
};

/** Short name for a community alias, or null when the phrase is not one. */
export function resolveAlias(normalisedQuery: string): string | null {
  return ITEM_ALIASES[normalisedQuery] ?? null;
}

/**
 * How to write an alias out: "ak" as AK, "bolty" as Bolty.
 *
 * Acronyms and model numbers are read as capitals, ordinary words are not —
 * "BOLTY" looks like shouting where "AK" looks correct.
 */
function displayForm(alias: string): string {
  if (alias.length <= 3 || /\d/.test(alias)) return alias.toUpperCase();
  return alias[0]!.toUpperCase() + alias.slice(1);
}

/**
 * Best community name per item, keyed by short name.
 *
 * The table above maps many aliases to one item; this picks one to write back
 * out. Shortest wins, ties broken alphabetically so the choice is stable
 * rather than dependent on key order.
 */
export const ALIAS_DISPLAY: Readonly<Record<string, string>> = (() => {
  const best: Record<string, string> = {};

  for (const [alias, short] of Object.entries(ITEM_ALIASES)) {
    const current = best[short];
    if (!current || alias.length < current.length || (alias.length === current.length && alias < current)) {
      best[short] = alias;
    }
  }

  return Object.fromEntries(Object.entries(best).map(([short, alias]) => [short, displayForm(alias)]));
})();
