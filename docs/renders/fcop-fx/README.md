# FCOP projectile / weapon-effect renders

`fx-cobj-contact.png` — every committed FX raw under
`tools/generators/units/raw/fcop-fx/`, drawn at 3/4 view with a Z-buffer.
Emissive `facer` geometry (the original's `Star` / `Billboard` / `Line`
primitives) is drawn hot, solid body geometry cool, because that split is what
separates an effect from a projectile body. The green rule in each cell is 1 m.

    bun run gen:fxcobj

Regenerate whenever the raw set changes. Cell order is left-to-right,
top-to-bottom and matches the table the command prints.

This sheet is the *pixel* half of the argument in
[`../../specs/fcop-fx.md`](../../specs/fcop-fx.md); the *data* half is the
actor-type 98/99 template tables in the RE extract. Neither alone settles which
mesh belongs to which weapon — read them together.

Reference only, never bundled into the client.
