/* Rays for Metropolis' port of the terrain trace (packages/sim/src/trace.ts),
 * answered by the decompiled trace itself (amigo-labs/fcop-reverse-engineering
 * src/game/world/trace.c). trace.c is included so the cell test's carried
 * scratch (g_pick_best) can be recorded before and after each ray: any subset
 * of the rays then replays exactly.
 *
 * Build against an RE checkout whose `build/` has libfcop_core.a (cmake -G Ninja
 * -B build && ninja -C build fcop_core):
 *
 *   RE=<RE checkout>
 *   cc -O2 -I"$RE/src/include" -I"$RE/src" -o trace_rays traceRays.c \
 *      "$RE/build/libfcop_core.a" -lSDL2 -lm
 *
 * The committed fixtures (packages/sim/test/fixtures/trace/<mission>.rays.gz)
 * are 4000 rays each, seeds 101.. in the order Conft Slim Mp Joke Hk Ovmp:
 *
 *   trace_rays "$RE/fixtures/missions/Mp" mp.rays 4000 103 && gzip -9 -n mp.rays
 *
 * Record: from {x, y, z}, to {x, y, z}, hit_floors, pick before, result, hit
 * {x, y, z} (0x7fffffff unwritten), candidates, pick after; 14 int32s, little
 * endian, after the header "MTRC" and the count.
 */
#include "game/world/trace.c"

#include <stdio.h>
#include <stdlib.h>

#include "fcop/alloc.h"
#include "fcop/log.h"
#include "fcop/res.h"

static u32 g_rng;
static u32 rnd(void)
{
    g_rng = g_rng * 1664525u + 1013904223u;
    return g_rng >> 8;
}
static i32 rrange(i32 lo, i32 hi) { return lo + (i32)(rnd() % (u32)(hi - lo + 1)); }

static void load_container(void)
{
    for (res_record *res = res_next_pending(true); res != NULL;
         res = res_next_pending(false)) {
        switch (res->tag) {
        case RES_TAG_CTIL:
        case RES_TAG_CATL:
            ctil_load(res);
            break;
        case RES_TAG_CPTC:
            cptc_load(res);
            break;
        default:
            res_free(res);
            break;
        }
    }
}

int main(int argc, char **argv)
{
    if (argc < 5) {
        fprintf(stderr, "usage: trace_rays <container> <out> <count> <seed>\n");
        return 2;
    }
    fcop_log_set_level(FCOP_LOG_ERROR);
    if (alloc_create() == 0) return 1;
    res_set_renderer_mode(0, false);
    res_stream_set_gate_bypass(true);
    res_stream_init(NULL);
    if (!res_stream_open(argv[1])) return 1;
    load_container();
    const i32 count = atoi(argv[3]);
    g_rng = (u32)atoi(argv[4]);
    const i32 width = cptc_width();   /* z cells */
    const i32 height = cptc_height(); /* x cells */
    const i32 margin = (i32)cptc_grid()[GRID_WORD_MARGIN];
    FILE *out = fopen(argv[2], "wb");
    u32 head[2] = {0x4352544du, (u32)count};
    fwrite(head, sizeof(head), 1, out);
    const i32 M = 0x2000; /* a metre */
    for (i32 n = 0; n < count; n++) {
        i32 fam = n % 6;
        i32 from[3], to[3];
        /* Mostly inside the playable area, sometimes anywhere on the grid. */
        i32 lo = (fam == 5) ? 0 : (margin - 1) * 0x20000;
        i32 hix = (fam == 5) ? height * 0x20000 : (height - margin + 1) * 0x20000;
        i32 hiz = (fam == 5) ? width * 0x20000 : (width - margin + 1) * 0x20000;
        from[0] = rrange(lo, hix - 1);
        from[2] = rrange(lo, hiz - 1);
        i32 len = (fam == 0) ? 32 * M : (fam == 1) ? 16 * M : (fam == 2) ? 3 * M : 24 * M;
        i32 dx = rrange(-len, len), dz = rrange(-len, len);
        if (fam == 3) {
            /* Axis-aligned or 45 degrees, from a sample boundary. */
            from[0] &= ~(M - 1);
            from[2] &= ~(M - 1);
            i32 k = rrange(0, 3);
            if (k == 0) dz = 0;
            else if (k == 1) dx = 0;
            else if (k == 2) dz = dx;
            else dz = -dx;
        }
        if (fam == 4 && (n & 1)) { dx = 0; dz = 0; } /* vertical */
        to[0] = from[0] + dx;
        to[2] = from[2] + dz;
        /* Heights: on or about the surfaces (topmost or lowest), as a shot
         * from a mech's gun to a target would be. */
        i32 layer_a = (rnd() & 1) ? -1 : -2;
        i32 layer_b = (rnd() & 1) ? -1 : -2;
        i32 pa[3] = {from[0], 0, from[2]};
        i32 pb[3] = {to[0], 0, to[2]};
        i32 ha = terrain_height_at(pa, layer_a);
        i32 hb = terrain_height_at(pb, layer_b);
        from[1] = ha + rrange(-2 * M, 6 * M);
        to[1] = hb + rrange(-2 * M, 6 * M);
        if (fam == 1) {
            from[1] = ha + rrange(M / 2, 2 * M);
            to[1] = hb + rrange(M / 2, 2 * M);
        }
        i32 floors = (fam == 2) ? 1 : (i32)(rnd() & 1);
        i32 pick_in = g_pick_best;
        if ((rnd() & 7) == 0) {
            pick_in = rrange(-0x3000, 0x3000);
            g_pick_best = pick_in;
        }
        i32 hit[3] = {0x7fffffff, 0x7fffffff, 0x7fffffff};
        u32 result = terrain_trace_segment(from, to, hit, NULL, floors);
        i32 rec[15] = {from[0], from[1], from[2], to[0], to[1], to[2], floors, pick_in,
                       (i32)result, hit[0], hit[1], hit[2], (i32)g_candidates, g_pick_best, 0};
        fwrite(rec, sizeof(i32), 14, out);
    }
    fclose(out);
    printf("%s: %d rays\n", argv[1], count);
    res_stream_close();
    return 0;
}
