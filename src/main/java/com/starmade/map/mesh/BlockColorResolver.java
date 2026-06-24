package com.starmade.map.mesh;

import org.schema.game.common.data.element.ElementInformation;
import org.schema.game.common.data.element.ElementKeyMap;

/**
 * Resolves a StarMade block type ID to a representative RGB color (packed 0xRRGGBB).
 *
 * StarMade does not expose a single "average" color per block, so we derive a real,
 * recognizable color from the most authoritative sources available at runtime:
 *   1. The block's light-source color, for lamps/lights (exact in-game glow color).
 *   2. Color words in the block's display name, for hull/armor/decorative variants
 *      (e.g. "Red Hull", "Blue Advanced Armor") -- this covers the bulk of a ship's
 *      visible surface.
 *   3. Functional/system block category keywords (shields, weapons, thrusters, power, FTL).
 *   4. A deterministic per-id fallback so unknown blocks still get a stable color.
 */
public final class BlockColorResolver {

    private BlockColorResolver() {}

    /** Neutral steel-grey used for plain hull and as a last resort. */
    private static final int HULL_GREY = 0x8A8F94;

    /**
     * @param type StarMade block type ID
     * @return packed 0xRRGGBB color
     */
    public static int resolve(short type) {
        if (type == 0) {
            return 0x000000;
        }

        // 1 + 2 + 3: use real block metadata when the element registry is loaded
        // (it is on a running server; it may be absent in offline/test contexts).
        try {
            ElementInformation info = ElementKeyMap.getInfoFast(type);
            if (info != null) {
                int fromInfo = fromInfo(info);
                if (fromInfo >= 0) {
                    return fromInfo;
                }
            }
        } catch (Throwable ignore) {
            // ElementKeyMap not initialized -- fall through to deterministic fallback.
        }

        return fallbackColor(type);
    }

    private static int fromInfo(ElementInformation info) {
        // Lamps and active blocks carry their real glow color here.
        javax.vecmath.Vector4f ls = info.lightSourceColor;
        if (ls != null && (ls.x + ls.y + ls.z) > 0.05f) {
            return rgb(ls.x, ls.y, ls.z);
        }

        String name = info.getName();
        if (name == null) {
            name = info.fullName;
        }
        if (name != null) {
            int byName = colorFromName(name.toLowerCase());
            if (byName >= 0) {
                return byName;
            }
        }
        return -1;
    }

    /**
     * Match color and system keywords in a block name. Order matters: more specific
     * words are checked before generic ones.
     */
    private static int colorFromName(String n) {
        // Functional / system blocks first (these rarely carry a color word).
        if (n.contains("shield")) return 0x29B6F6;                 // cyan
        if (n.contains("thrust") || n.contains("jet")) return 0xFF8A33; // orange glow
        if (n.contains("reactor") || n.contains("power") || n.contains("generator")) return 0x35D07A; // green
        if (n.contains("jump") || n.contains("ftl") || n.contains("warp")) return 0xB45CFF; // purple
        if (n.contains("cannon") || n.contains("missile") || n.contains("beam")
                || n.contains("damage") || n.contains("weapon") || n.contains("turret")) return 0xE74C3C; // red

        // Color-bearing hull / armor / decorative blocks.
        if (n.contains("black")) return 0x23262B;
        if (n.contains("white")) return 0xE8EEF2;
        if (n.contains("grey") || n.contains("gray")) return HULL_GREY;
        if (n.contains("red")) return 0xC0392B;
        if (n.contains("orange")) return 0xE67E22;
        if (n.contains("yellow")) return 0xF1C40F;
        if (n.contains("lime")) return 0x9BD938;
        if (n.contains("green")) return 0x27AE60;
        if (n.contains("teal") || n.contains("cyan")) return 0x1ABC9C;
        if (n.contains("blue")) return 0x2E86DE;
        if (n.contains("purple") || n.contains("violet")) return 0x8E44AD;
        if (n.contains("pink") || n.contains("magenta")) return 0xE84393;
        if (n.contains("brown")) return 0x8B5A2B;
        if (n.contains("tan") || n.contains("beige")) return 0xCBB994;

        // Generic hull/armor with no color word -> standard grey.
        if (n.contains("hull") || n.contains("armor") || n.contains("armour")) return HULL_GREY;

        return -1;
    }

    /**
     * Stable, pleasant fallback color derived from the block id, so unknown or
     * unregistered blocks still render distinctly and consistently between requests.
     */
    private static int fallbackColor(short type) {
        // Spread hues across the wheel using the id; keep medium saturation/value.
        float hue = ((type * 47) % 360) / 360.0f;
        return hsv(hue, 0.45f, 0.78f);
    }

    private static int rgb(float r, float g, float b) {
        int ri = clamp255(Math.round(r * 255f));
        int gi = clamp255(Math.round(g * 255f));
        int bi = clamp255(Math.round(b * 255f));
        return (ri << 16) | (gi << 8) | bi;
    }

    private static int hsv(float h, float s, float v) {
        float r = 0, g = 0, b = 0;
        int i = (int) Math.floor(h * 6f);
        float f = h * 6f - i;
        float p = v * (1f - s);
        float q = v * (1f - f * s);
        float t = v * (1f - (1f - f) * s);
        switch (i % 6) {
            case 0: r = v; g = t; b = p; break;
            case 1: r = q; g = v; b = p; break;
            case 2: r = p; g = v; b = t; break;
            case 3: r = p; g = q; b = v; break;
            case 4: r = t; g = p; b = v; break;
            case 5: r = v; g = p; b = q; break;
        }
        return rgb(r, g, b);
    }

    private static int clamp255(int v) {
        return v < 0 ? 0 : (v > 255 ? 255 : v);
    }
}
