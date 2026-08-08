import Svg, { Circle, G, Path } from 'react-native-svg'

const STROKE_W = 1.3

/**
 * Pilot wings glyph — the bold airline-badge style RC picked: a solid center
 * circle with 3 horizontal bars per side, stacked top to bottom, each one
 * shorter than the one above, cut at a clear diagonal angle at the OUTER
 * tip, but with an INNER edge that's a real concentric arc matching the
 * circle's own curvature (at a larger radius, so there's open space and it
 * never touches) rather than a flat angled cut. SF Symbols has no wings/
 * insignia glyph (see AviationHeadset.tsx for the same gap with a headset),
 * so this is drawn directly as an SVG path.
 *
 * RC corrections that got this shape here, in order: tapered bars read as
 * insect legs -> constant-width bars; angled bars -> flat horizontal bars
 * with a diagonal-cut tip; "twice as long, with open space around the
 * circle" made the whole glyph read tiny (a wide, short composition gets
 * squashed to fit a square icon slot); "make the circle bigger" fixed that
 * by adding real vertical extent; then RC caught that the inner (root) edge
 * was ALSO just a flat diagonal cut, when it should curve to match the
 * circle's contour even though it doesn't touch it -- each bar's inner
 * corners are computed to sit exactly on a circle of radius `innerR`
 * (the badge circle's radius plus the gap), so the connecting arc is a true
 * concentric arc, guaranteed to read as "the same curve, just offset out".
 */
export function PilotWings({ size = 22, color = '#000' }: { size?: number; color?: string }) {
  const R = 9
  const gap = 1.5
  const innerR = R + gap
  const halfW = 1.8
  const skew = 2
  // One horizontal bar: top and bottom long edges are perfectly horizontal
  // (never angled), meeting a diagonal-cut tip on the outside and, on the
  // inside, either a concentric arc (radius innerR, centered on the badge
  // circle) or -- for the top bar, per RC -- a straight 45-degree cut down
  // to where it meets the ring instead, matching the reference image.
  // Both corners are computed from the SAME circle of radius innerR either
  // way, so a straight line between them already lands close to 45 degrees
  // on its own at this bar's height -- `straightInner` just skips the arc.
  // RC: "the rest of the icons are basically just lines w/ no fill" -- and
  // "make the top line of the top bar a bit thicker". Each bar's 4 edges
  // (inner root, top, outer tip cut, bottom) used to be one single closed
  // stroked path, so every edge shared one strokeWidth by construction --
  // there was no way to single out just the top edge. Split into 4
  // separate line segments so the top edge alone can take its own
  // `topStrokeWidth`, defaulting to the same width as the other 3.
  const bar = (length: number, centerY: number, straightInner = false, topStrokeWidth = STROKE_W) => {
    const topY = centerY - halfW
    const bottomY = centerY + halfW
    const innerTopX = Math.sqrt(innerR * innerR - topY * topY)
    const innerBottomX = Math.sqrt(innerR * innerR - bottomY * bottomY)
    const tipTopX = innerR + length + skew
    const tipBottomX = innerR + length
    const innerEdgeD = straightInner
      ? `M${innerBottomX},${bottomY} L${innerTopX},${topY}`
      : `M${innerBottomX},${bottomY} A${innerR},${innerR} 0 0,0 ${innerTopX},${topY}`
    return (
      <G>
        <Path d={innerEdgeD} fill="none" stroke={color} strokeWidth={STROKE_W} />
        <Path d={`M${innerTopX},${topY} L${tipTopX},${topY}`} fill="none" stroke={color} strokeWidth={topStrokeWidth} />
        <Path d={`M${tipTopX},${topY} L${tipBottomX},${bottomY}`} fill="none" stroke={color} strokeWidth={STROKE_W} />
        <Path d={`M${tipBottomX},${bottomY} L${innerBottomX},${bottomY}`} fill="none" stroke={color} strokeWidth={STROKE_W} />
      </G>
    )
  }

  // RC: "bars borders only, no fill" -- and "put a star in the middle of
  // the circle instead of a dot" (the old inner ring at r=3.5/strokeWidth=4
  // was thick enough relative to its own radius to read as a solid dot,
  // not a donut). A standard 5-point star, outer radius 6 / inner radius
  // 2.4 (same 0.4 ratio throughout, scaled up twice per RC: "make the star
  // bigger" then "a bit bigger" again), point straight up -- outer and
  // inner vertices alternating every 36 degrees around the center.
  const star = (
    <Path
      d="M0,-6 L1.411,-1.942 L5.706,-1.854 L2.282,0.742 L3.527,4.854 L0,2.4 L-3.527,4.854 L-2.282,0.742 L-5.706,-1.854 L-1.411,-1.942 Z"
      fill={color}
    />
  )

  // RC: "double the size of the whole icon" -- rendered at 2x the size the
  // tab bar hands us rather than asking every caller to pass a bigger size,
  // since this is the one icon meant to read as noticeably bigger/bolder
  // than its house/bookmark/clock siblings, not a global icon-size change.
  const renderSize = size * 2

  // RC: "keep the bottom bar where it is, move the two top sets up more" --
  // bar3 (bottom) stays at its original 5.2; bar1's centerY is pulled up so
  // its top edge (centerY - halfW) sits a clear margin below the circle's
  // own top edge (-R) -- RC first asked for that margin to be almost
  // nothing, then corrected it the other way ("make the top of the ring
  // stick up higher than the top bar, more than it is") -- so `topMargin`
  // is now a deliberately visible gap, not a near-touch. bar2 is respaced
  // evenly between the new bar1 and the unchanged bar3.
  const topMargin = 3
  const bar1Y = -(R - topMargin) + halfW
  const bar3Y = 5.2
  const bar2Y = (bar1Y + bar3Y) / 2

  // RC: "the angle of the outer ends of the bars is in a straight line --
  // instead, extend higher out beyond the length of the set below it." The
  // previous lengths (11, 9, 7) stepped down by a fixed 2 each time, so the
  // three tips lined up on one flat diagonal. These step up non-linearly
  // instead -- the top bar reaches well past where a straight line through
  // the bottom two tips would put it, giving the silhouette a flared curve
  // rather than a flat taper.
  return (
    <Svg width={renderSize} height={renderSize} viewBox="-29 -9.5 58 19">
      {/* Right wing: 3 horizontal bars, longest on top */}
      <G>
        {bar(16, bar1Y, true, 2.2)}
        {bar(10, bar2Y)}
        {bar(4.5, bar3Y)}
      </G>
      {/* Left wing: same three bars, mirrored */}
      <G transform="scale(-1 1)">
        {bar(16, bar1Y, true, 2.2)}
        {bar(10, bar2Y)}
        {bar(4.5, bar3Y)}
      </G>
      {/* Center badge -- outer ring, plus a second, smaller ring inside it
          (a donut, not a filled disc, per RC) with a small clear center.
          Outer edge held at the same 5.5 the filled version used, so this
          keeps its existing footprint. Drawn last so both sit on top of the
          wings' roots. */}
      <Circle cx={0} cy={0} r={R} fill="none" stroke={color} strokeWidth={2.2} />
      {star}
    </Svg>
  )
}
