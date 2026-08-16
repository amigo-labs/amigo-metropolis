// Paths to the original Future Cop weapon art (febmp.bin via the RE extract).
// Icon = 45×42 portrait used on the loadout strip; panel = 134×39/40 bar card
// kept for reference / future full hardpoint UI. Names match WeaponDef.name.

/** Stable URL slug for a catalog display name. */
export function weaponArtSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** 45×42 weapon portrait for the menu strip. */
export function weaponIconUrl(name: string): string {
  return `/ui/weapons/icons/${weaponArtSlug(name)}.png`;
}
