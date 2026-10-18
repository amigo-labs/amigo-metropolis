// PREFERENCES: the original's options dialog (template 0x65,
// options_dialog.c 0x00402030). Only what means something in a browser is
// live: FullScreen (the Fullscreen API), Controller Configuration and Audio.
// Display Mode, Texture Coloring, Processor Select and the 3DFX options are
// drawn as the original draws them and greyed (fcop-fidelity.md F12). Two
// Metropolis additions, marked as such: the HD textures option (a platform
// exception; Classic, the original texels, stays the default) and the
// "Spielregeln" group with the owner's "Kampagnenwaffen" rule (F23; off by
// default, the original's Precinct Assault; in the networked lobby only the
// host may change it).
//
// As the original's: Ok writes the pending choices, Cancel and Escape leave.

import { useState } from "preact/hooks";
import type { AudioEngine } from "../../audio/engine";
import type { Binding } from "../../input/bindings";
import { loadTexPref, saveTexPref, type TexPref } from "../../render/texVariants";
import { FE_DIALOGS } from "../frontend/frontendData.generated";
import {
  dialogLayout,
  W9Button,
  W9Check,
  W9Combo,
  W9Group,
  W9Static,
  W9Trackbar,
  W9Window,
} from "../win9x/Win9x";
import { AudioDialog } from "./AudioDialog";
import { ControlsDialog } from "./ControlsDialog";

const D = FE_DIALOGS.options;

/** The resolution list's eleven rows (options_dialog.c RESOLUTIONS). */
export const DISPLAY_MODES: readonly string[] = [
  "320x240",
  "400x300",
  "480x360",
  "512x384",
  "640x480",
  "800x600",
  "960x720",
  "1024x768",
  "1120x840",
  "1280x960",
  "1600x1200",
];
/** The processor rows (0x00486278). */
export const PROCESSORS: readonly string[] = ["AutoDetect", "Pentium", "Pentium II"];

/** Where the Metropolis addition sits: the free row under Audio, in the dialog's units. */
export const HD_TEXTURES_DLU: readonly number[] = [7, 121, 120, 10];
export const HD_TEXTURES_TEXT = "HD Textures (Metropolis)";
/** The game rules: the free corner right of HD textures, above Cancel. */
export const RULES_GROUP_DLU: readonly number[] = [132, 117, 137, 20];
export const RULES_GROUP_TEXT = "Spielregeln (Metropolis)";
export const CAMPAIGN_WEAPONS_DLU: readonly number[] = [138, 126, 125, 9];
export const CAMPAIGN_WEAPONS_TEXT = "Kampagnenwaffen";

export interface GameRules {
  readonly campaignWeapons: boolean;
}

export function OptionsDialog(props: {
  audio: AudioEngine;
  onClose(): void;
  onTexPref(pref: TexPref): void;
  onControls?(tables: Binding[][]): void;
  /** The game rules as they stand; absent hides the group. */
  rules?: GameRules;
  /** The joiner's lobby: shown, not changed (the host sets the rules). */
  rulesLocked?: boolean;
  /** Ok with changed rules. */
  onRules?(rules: GameRules): void;
}) {
  const L = dialogLayout(D);
  const [campaign, setCampaign] = useState<boolean>(() => props.rules?.campaignWeapons ?? false);
  const [full, setFull] = useState<boolean>(() => !!document.fullscreenElement);
  const [hd, setHd] = useState<boolean>(() => loadTexPref() === "hd");
  const [sub, setSub] = useState<"controls" | "audio" | null>(null);

  const ok = (): void => {
    // Ok writes the pending pair; the browser can apply full screen at once,
    // inside the click that asked for it.
    if (full && !document.fullscreenElement) {
      void document.documentElement.requestFullscreen?.().catch(() => {});
    } else if (!full && document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => {});
    }
    const pref: TexPref = hd ? "hd" : "original";
    if (pref !== loadTexPref()) {
      saveTexPref(pref);
      props.onTexPref(pref);
    }
    if (props.rules && !props.rulesLocked && campaign !== props.rules.campaignWeapons) {
      props.onRules?.({ campaignWeapons: campaign });
    }
    props.onClose();
  };

  return (
    <>
      <W9Window
        layout={L}
        label="Preferences"
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onClose();
        }}
      >
        <W9Static rect={L.rect(1155)} text={L.text(1155)} />
        <W9Combo
          rect={L.rect(1021)}
          items={DISPLAY_MODES}
          selected={4}
          open={false}
          disabled
          label={L.text(1155)}
          lineHeight={13}
        />
        <W9Static rect={L.rect(1110)} text={L.text(1110)} />
        <W9Check rect={L.rect(1012)} text={L.text(1012)} checked={full} onChange={setFull} />
        <W9Check rect={L.rect(1014)} text={L.text(1014)} checked disabled />
        <W9Static rect={L.rect(1111)} text={L.text(1111)} />
        <W9Combo
          rect={L.rect(1023)}
          items={PROCESSORS}
          selected={0}
          open={false}
          disabled
          label={L.text(1111)}
          lineHeight={13}
        />
        <W9Group rect={L.rect(1125)} text={L.text(1125)} disabled />
        <W9Check rect={L.rect(1013)} text={L.text(1013)} checked disabled />
        <W9Static rect={L.rect(1112)} text={L.text(1112)} disabled />
        <W9Trackbar
          rect={L.rect(1118)}
          min={0}
          max={100}
          value={50}
          disabled
          label={L.text(1112)}
        />
        <W9Static rect={L.rect(1127)} text={L.text(1127)} disabled />
        <W9Static rect={L.rect(1128)} text={L.text(1128)} disabled />
        <W9Button rect={L.rect(1099)} text={L.text(1099)} onClick={() => setSub("controls")} />
        <W9Button rect={L.rect(1100)} text={L.text(1100)} onClick={() => setSub("audio")} />
        <W9Check
          rect={L.at(HD_TEXTURES_DLU)}
          text={HD_TEXTURES_TEXT}
          checked={hd}
          onChange={setHd}
        />
        {props.rules ? (
          <>
            <W9Group rect={L.at(RULES_GROUP_DLU)} text={RULES_GROUP_TEXT} />
            <W9Check
              rect={L.at(CAMPAIGN_WEAPONS_DLU)}
              text={CAMPAIGN_WEAPONS_TEXT}
              checked={props.rulesLocked ? props.rules.campaignWeapons : campaign}
              disabled={props.rulesLocked}
              onChange={setCampaign}
            />
          </>
        ) : null}
        <W9Button rect={L.rect(1001)} text={L.text(1001)} isDefault autoFocus onClick={ok} />
        <W9Button rect={L.rect(1002)} text={L.text(1002)} onClick={props.onClose} />
      </W9Window>
      {sub === "controls" ? (
        <ControlsDialog onClose={() => setSub(null)} onControls={props.onControls} />
      ) : null}
      {sub === "audio" ? <AudioDialog audio={props.audio} onClose={() => setSub(null)} /> : null}
    </>
  );
}
