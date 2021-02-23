"use strict"
var canvas
var ctx
var mousePressed
var polygon
var velocity
var yZero

window.onload = main
function main() {
    canvas = document.getElementById("canvas")
    ctx = canvas.getContext("2d")

    /* Get the water level. */
    yZero = canvas.height / 3
    mousePressed = false
    var h = canvas.width * 9/16
    if (h > window.height - 50)
        h = window.height - 50
    canvas.height = h
    draw_background()
    window.addEventListener('mousedown', mousedown)
    window.addEventListener('touchstart', mousedown)
    window.addEventListener('mousemove', mousemove)
    window.addEventListener('touchmove', mousemove)
    window.addEventListener('mouseup', mouseup)
    window.addEventListener('touchend', mouseup)
    var tick_repeat = function() {
        tick()
        setTimeout(tick_repeat, 50)
    }
    tick_repeat()
}

/* Draw backgound. */
function draw_background() {
    /* Sky */
    ctx.beginPath()
    ctx.fillStyle = "#bbddee"
    ctx.moveTo(0, 0)
    ctx.lineTo(0, ctx.canvas.height)
    ctx.lineTo(ctx.canvas.width, ctx.canvas.height)
    ctx.lineTo(ctx.canvas.width, 0)
    ctx.closePath()
    ctx.fill()

    /* Water */
    draw_water()
}

function draw_water() {
    ctx.beginPath()
    ctx.fillStyle = "#2c7bb6"
    ctx.moveTo(0, yZero)
    ctx.lineTo(0, ctx.canvas.height)
    ctx.lineTo(ctx.canvas.width, ctx.canvas.height)
    ctx.lineTo(ctx.canvas.width, yZero)
    ctx.closePath()
    ctx.fill()
}

function add_point(e) {
    if (e.touches)
        e = e.touches[0]

    var rect = canvas.getBoundingClientRect()
    var x = e.clientX - rect.left
    var y = e.clientY - rect.top
    polygon.push([x, y])

    /* Draw lasso. */
    if (polygon.length >= 2) {
        ctx.beginPath()
        ctx.strokeStyle = "black"
        ctx.lineWidth = 3
        ctx.lineJoin = "round"
        ctx.moveTo(polygon[polygon.length-2][0], polygon[polygon.length-2][1])
        ctx.lineTo(polygon[polygon.length-1][0], polygon[polygon.length-1][1])
        ctx.closePath()
        ctx.stroke()
    }
}

function mousedown(e) {
        /* Reset canvas. */
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    draw_background()
    draw_water()

    mousePressed = true
    polygon = []
    add_point(e)
}

function mousemove(e) {
    if (mousePressed)
        add_point(e)
}

function mouseup(e) {
    /* Finish drawing - reset the polygon and inertia */
    mousePressed = false
    if (polygon.length < 3) {
        polygon = null
        return
    }
    if (polygon.length > 0) /* make first and last point the same */
        polygon.push(polygon[0])
    velocity = [0, 0, 0]

    /*
     People like to draw shapes with kinks, which results
     in part of the polygon being treated as negative area.
     turf.unkinkPolygon can be used to find the kinks and
     separate the polygon into multiple polygons at the
     kinks, but it's a little fragile and hard to combine
     into a single unkinked polygon. We also want to avoid
     showing errors when there are just small degenerate
     kinds from messy drawing.
     (If turf.kinks(turf.polygon([polygon])).features.length
     is non-zero, there are kinks. We could show an error,
     but that's not friendly.) */
    try {
        /* Remove duplicate vertices which breaks unkinkPolygon. */
        var found_vertices = { }
        var polygon2 = []
        polygon.forEach(function(pt) {
            var k = pt[0] + "|" + pt[1]
            if (k in found_vertices) return
            found_vertices[k] = true
            polygon2.push(pt)
        })
        polygon = polygon2
        polygon.push(polygon[0])

        /* Split polygon into parts separated at kinks. */
        var k = turf.polygon([polygon])
        k = turf.unkinkPolygon(k)
        if (k.features.length > 1) {
            /* Take the part with the largest area. */
            k = k.features.map(function(kk) { return kk.geometry.coordinates[0]; })
            var areas = k.map(polygonArea)
            var maxArea = 0, maxAreaIndex = 0
            areas.forEach(function(area, i) {
                if (area > maxArea) {
                    maxArea = area
                    maxAreaIndex = i
                }
            })
            polygon = k[maxAreaIndex]
        }
    } catch (e) {
    }
}

function tick() {
    if (!polygon || polygon.length < 4 || mousePressed)
        return

    /* Compute the center of mass of the iceberg and the
       center of mass of the submerged portion. */
    var pc = centroid(polygon)
    var polygon_submerged = turf.bboxClip(turf.polygon([polygon]),
                                          [-Infinity, yZero, Infinity, Infinity]).geometry.coordinates[0]
    var pc_submerged = (polygon_submerged && polygon_submerged.length >= 4) ? centroid(polygon_submerged) : [0, 0]

    /* The vector between the two centroids determines a
     force that is applied. Gravity pulls down (+y because
     the canvas coordinates are upside-down) at the
     center of mass of the full iceberg and bouyancy
     pushes up (-y) at the center of mass of the submerged
     portion. */
    var specific_gravity = .85
    var fg = 1
    var submerged_ratio = polygonArea(polygon_submerged) / polygonArea(polygon)
    var fb = submerged_ratio / specific_gravity
    var fy = fg - fb

    /* In reality, the 3D distribution of mass is not uniform
       across the 2D projection of the iceberg that we are looking
       at. While we can assume that it's close, when we chop off
       the top of the iceberg to find the submerged portion,
       the centroid of the submerged portion is likely to be closer
       to the total centroid than the centroid of the projection of
       the submerged part because what we chop off is always close
       to an edge and the edges have lower density than in the middle.
       Adjust the centroid location of the submerged part accordingly.
       When half-way submerged, move the centroid 20% closer to the
       full cenroid. */
    var r = (submerged_ratio < .5 ? submerged_ratio : (1 - submerged_ratio)) * 2 * .2
    pc_submerged[0] = pc_submerged[0]*(1-r) + pc[0]*r
    pc_submerged[1] = pc_submerged[1]*(1-r) + pc[1]*r

    /* Apply a moment at the centroid of the iceberg due to
       the eccentricity between the iceberg centroid and the
       centroid of the submerged portion where the bouyant
       force acts. */
    var mz = fb * (pc_submerged[0] - pc[0])

    /* The force is normalized to the polygon area so we can
       consider it an acceleration. Increment the velocity
       with the acceleration. */
    velocity[1] += fy
    velocity[2] += mz / 30

    //* If the polygon is out of the horizontal bounds, push it in. */
    var minx = Infinity, maxx = -Infinity
    polygon.forEach(function(pt) {
        if (pt[0] < minx) minx = pt[0]
        if (pt[0] > maxx) maxx = pt[0]
    })
    if (minx < 0) velocity[0] += -minx/ctx.canvas.width * 10
    if (maxx > ctx.canvas.width) velocity[0] += (ctx.canvas.width-maxx)/ctx.canvas.width * 10

    /* Apply damping. There is more damping in water than in air.
       Lowering the damping in air boosts the free-fall a bit for
       a nice effect when it hits the water. */
    var damping_air = .99
    var damping_water = .94
    var damping = damping_air*(1-submerged_ratio) + damping_water*submerged_ratio
    velocity[0] *= damping
    velocity[1] *= damping
    velocity[2] *= (damping-.1)

    /* Apply velocity to the coordinates. */
    polygon = polygon.map(function(pt) {
        pt = rotate(pc[0], pc[1], pt[0], pt[1], velocity[2])
        pt[0] += velocity[0]
        pt[1] += velocity[1]
        return pt
    })

    /* Melt the iceberg slowly. Melt faster above water. */
    polygon.forEach(function(pt) {
        if (pt[1] < yZero)
            pt[1] = (pt[1] - yZero)*.9999 + yZero
        else
            pt[1] = (pt[1] - yZero)*.99999 + yZero
    })

    /* Reset canvas. */
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)

    /* Re-draw polygon as a filled iceberg now.
       TODO: Draw ice texture */
    draw_background()
    ctx.beginPath()
    ctx.strokeStyle = "black"
    ctx.fillStyle = "white"
    ctx.lineWidth = 2
    ctx.lineJoin = "round"
    ctx.moveTo(polygon[0][0], polygon[0][1])
    polygon.forEach(function(pt) {
        ctx.lineTo(pt[0], pt[1])
    })
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    ctx.globalAlpha = .5
    draw_water()
    ctx.globalAlpha = 1
}

function centroid(pts) {
    /* https://stackoverflow.com/a/33852627 */
    var nPts = pts.length
    var off = pts[0]
    var twicearea = 0
    var x = 0
    var y = 0
    var p1,p2
    var f
    for (var i = 0, j = nPts - 1; i < nPts; j = i++) {
        p1 = pts[i]
        p2 = pts[j]
        f = (p1[0] - off[0]) * (p2[1] - off[1]) - (p2[0] - off[0]) * (p1[1] - off[1])
        twicearea += f
        x += (p1[0] + p2[0] - 2 * off[0]) * f
        y += (p1[1] + p2[1] - 2 * off[1]) * f
    }
    f = twicearea * 3
    return [ x / f + off[0], y / f + off[1] ]
}

function polygonArea(vertices) {
    if (!vertices || vertices.length < 4) return 0
    /* https://stackoverflow.com/a/33670691 */
    var total = 0
    for (var i = 0, l = vertices.length; i < l; i++) {
        var addX = vertices[i][0]
        var addY = vertices[i == vertices.length - 1 ? 0 : i + 1][1]
        var subX = vertices[i == vertices.length - 1 ? 0 : i + 1][0]
        var subY = vertices[i][1]

        total += (addX * addY * 0.5)
        total -= (subX * subY * 0.5)
    }
    return Math.abs(total)
}

function rotate(cx, cy, x, y, angle) {
    /* https://stackoverflow.com/a/17411276 */
    var radians = (Math.PI / 180) * angle,
        cos = Math.cos(radians),
        sin = Math.sin(radians),
        nx = (cos * (x - cx)) + (sin * (y - cy)) + cx,
        ny = (cos * (y - cy)) - (sin * (x - cx)) + cy
    return [nx, ny]
}
