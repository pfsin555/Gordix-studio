/*
 * GORDIX Studio — DXF 讀取器（支援曲線）/ DXF reader with curve support
 *
 * GordixDXF.parse(text, opts) -> { paths: [{ points:[{x,y}], layer, closed }], insunits }
 *
 * 支援 / Supported entities:
 *   LINE, LWPOLYLINE (含 bulge 圓弧), POLYLINE/VERTEX (含 bulge), CIRCLE, ARC,
 *   ELLIPSE (含部分橢圓), SPLINE (NURBS: 節點 + 權重；無控制點時用擬合點),
 *   INSERT (展開 BLOCK：基準點、比例、旋轉、巢狀、陣列)
 * 座標保持 DXF 原始座標 (Y 向上)，與舊版處理一致。
 * OCS 擠出方向 Z<0 (鏡像) 時會將 X 反轉。
 */
(function () {
    var TAU = Math.PI * 2;

    function readPairs(text) {
        var lines = text.split(/\r\n|\r|\n/);
        var pairs = [];
        for (var i = 0; i + 1 < lines.length; i += 2) {
            var c = parseInt(lines[i].trim(), 10);
            if (isNaN(c)) { i -= 1; continue; } // 重新對齊
            pairs.push([c, lines[i + 1].trim()]);
        }
        return pairs;
    }

    // 將 pairs 拆成 { type, codes:[[c,v]...] } 的實體列表
    function splitEntities(pairs, start, end) {
        var ents = [], cur = null;
        for (var i = start; i < end; i++) {
            var p = pairs[i];
            if (p[0] === 0) {
                if (cur) ents.push(cur);
                cur = { type: p[1].toUpperCase(), codes: [] };
            } else if (cur) {
                cur.codes.push(p);
            }
        }
        if (cur) ents.push(cur);
        return ents;
    }

    function first(codes, c, def) {
        for (var i = 0; i < codes.length; i++) if (codes[i][0] === c) return parseFloat(codes[i][1]);
        return def;
    }
    function firstStr(codes, c, def) {
        for (var i = 0; i < codes.length; i++) if (codes[i][0] === c) return codes[i][1];
        return def;
    }
    function all(codes, c) {
        var out = [];
        for (var i = 0; i < codes.length; i++) if (codes[i][0] === c) out.push(parseFloat(codes[i][1]));
        return out;
    }

    // ---- 弧線離散化 ----
    var TOL = 0.01; // 弦高誤差 (圖面單位)
    function segCount(r, sweep) {
        r = Math.abs(r);
        if (r <= TOL) return Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 8)));
        var step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - TOL / r)));
        var n = Math.ceil(Math.abs(sweep) / step);
        return Math.max(4, Math.min(1440, n));
    }

    function arcPoints(cx, cy, r, a0, a1) { // a0 -> a1 逆時針 (rad)
        var sweep = a1 - a0;
        while (sweep <= 0) sweep += TAU;
        if (sweep > TAU + 1e-9) sweep = TAU;
        var n = segCount(r, sweep), pts = [];
        for (var i = 0; i <= n; i++) {
            var a = a0 + sweep * i / n;
            pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
        }
        return pts;
    }

    // bulge 線段：p0 -> p1，bulge = tan(θ/4)，正值為逆時針
    function bulgePoints(p0, p1, b) {
        if (!b || Math.abs(b) < 1e-12) return [p1];
        var dx = p1.x - p0.x, dy = p1.y - p0.y;
        var chord = Math.hypot(dx, dy);
        if (chord < 1e-12) return [p1];
        var theta = 4 * Math.atan(b);              // 帶正負號的圓心角
        var r = chord / (2 * Math.sin(Math.abs(theta) / 2));
        var mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
        var d = (chord / 2) / Math.tan(theta / 2);   // 有號距離：正值在弦的左側
        var nx = -dy / chord, ny = dx / chord;       // 弦的左法線
        var cx = mx + nx * d, cy = my + ny * d;
        var a0 = Math.atan2(p0.y - cy, p0.x - cx);
        var n = segCount(r, theta), pts = [];
        for (var i = 1; i <= n; i++) {
            var a = a0 + theta * i / n;
            pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
        }
        pts[pts.length - 1] = { x: p1.x, y: p1.y };
        return pts;
    }

    function polyWithBulge(verts, closed) {
        if (verts.length === 0) return [];
        var pts = [{ x: verts[0].x, y: verts[0].y }];
        var n = verts.length, last = closed ? n : n - 1;
        for (var i = 0; i < last; i++) {
            var a = verts[i], b = verts[(i + 1) % n];
            pts = pts.concat(bulgePoints(a, b, a.bulge || 0));
        }
        return pts;
    }

    // ---- NURBS (de Boor) ----
    function findSpan(k, p, u, U) {
        var n = k - 1;
        if (u >= U[n + 1]) return n;
        if (u <= U[p]) return p;
        var lo = p, hi = n + 1, mid = (lo + hi) >> 1;
        while (u < U[mid] || u >= U[mid + 1]) {
            if (u < U[mid]) hi = mid; else lo = mid;
            mid = (lo + hi) >> 1;
        }
        return mid;
    }
    function deBoor(p, U, P, W, u) {
        var k = findSpan(P.length, p, u, U);
        var d = [];
        for (var j = 0; j <= p; j++) {
            var cp = P[j + k - p], w = W[j + k - p];
            d.push({ x: cp.x * w, y: cp.y * w, w: w });
        }
        for (var r = 1; r <= p; r++) {
            for (var j2 = p; j2 >= r; j2--) {
                var i = j2 + k - p;
                var den = U[i + p - r + 1] - U[i];
                var al = den === 0 ? 0 : (u - U[i]) / den;
                d[j2] = {
                    x: (1 - al) * d[j2 - 1].x + al * d[j2].x,
                    y: (1 - al) * d[j2 - 1].y + al * d[j2].y,
                    w: (1 - al) * d[j2 - 1].w + al * d[j2].w
                };
            }
        }
        var q = d[p];
        return { x: q.x / q.w, y: q.y / q.w };
    }

    function splinePoints(codes) {
        var deg = first(codes, 71, 3);
        var flags = first(codes, 70, 0);
        var knots = all(codes, 40);
        var wts = all(codes, 41);
        var cx = all(codes, 10), cy = all(codes, 20);
        var fx = all(codes, 11), fy = all(codes, 21);
        var P = [];
        for (var i = 0; i < Math.min(cx.length, cy.length); i++) P.push({ x: cx[i], y: cy[i] });

        if (P.length >= 2 && knots.length === P.length + deg + 1) {
            var W = [];
            for (var w = 0; w < P.length; w++) W.push(wts.length === P.length && wts[w] > 0 ? wts[w] : 1);
            var u0 = knots[deg], u1 = knots[P.length];
            // 依控制多邊形長度決定取樣數
            var len = 0;
            for (var m = 1; m < P.length; m++) len += Math.hypot(P[m].x - P[m - 1].x, P[m].y - P[m - 1].y);
            var n = Math.max(P.length * 12, Math.ceil(len / 0.5));
            n = Math.max(16, Math.min(5000, n));
            var pts = [];
            for (var s = 0; s <= n; s++) {
                var u = u0 + (u1 - u0) * s / n;
                if (s === n) u = u1 - 1e-12 * Math.max(1, Math.abs(u1));
                pts.push(deBoor(deg, knots, P, W, u));
            }
            pts[pts.length - 1] = deBoor(deg, knots, P, W, u1 - 1e-9 * Math.max(1, Math.abs(u1 - u0)));
            if (deg === 1 || (flags & 8)) { /* linear / planar */ }
            return { pts: pts, closed: !!(flags & 1) };
        }
        // 只有擬合點：以 Catmull-Rom 平滑通過擬合點
        var F = [];
        for (var f = 0; f < Math.min(fx.length, fy.length); f++) F.push({ x: fx[f], y: fy[f] });
        if (F.length < 2 && P.length >= 2) F = P; // 退而求其次：控制點折線
        return { pts: catmullRom(F, !!(flags & 1)), closed: !!(flags & 1) };
    }

    function catmullRom(F, closed) {
        if (F.length < 3) return F.slice();
        var out = [F[0]], n = F.length, segs = closed ? n : n - 1;
        for (var i = 0; i < segs; i++) {
            var p0 = F[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
            var p1 = F[i], p2 = F[(i + 1) % n];
            var p3 = F[closed ? (i + 2) % n : Math.min(n - 1, i + 2)];
            for (var t = 1; t <= 16; t++) {
                var s = t / 16, s2 = s * s, s3 = s2 * s;
                out.push({
                    x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * s + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * s2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * s3),
                    y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * s + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * s2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * s3)
                });
            }
        }
        return out;
    }

    function ellipsePoints(codes) {
        var cx = first(codes, 10, 0), cy = first(codes, 20, 0);
        var mx = first(codes, 11, 1), my = first(codes, 21, 0);
        var ratio = first(codes, 40, 1);
        var t0 = first(codes, 41, 0), t1 = first(codes, 42, TAU);
        var a = Math.hypot(mx, my), b = a * ratio, rot = Math.atan2(my, mx);
        var sweep = t1 - t0;
        while (sweep <= 0) sweep += TAU;
        if (sweep > TAU + 1e-9) sweep = TAU;
        var n = segCount(a, sweep), pts = [];
        var c = Math.cos(rot), s = Math.sin(rot);
        for (var i = 0; i <= n; i++) {
            var t = t0 + sweep * i / n;
            var ex = a * Math.cos(t), ey = b * Math.sin(t);
            pts.push({ x: cx + ex * c - ey * s, y: cy + ex * s + ey * c });
        }
        return { pts: pts, closed: Math.abs(sweep - TAU) < 1e-6 };
    }

    // ---- 實體 -> 路徑 ----
    function mirrorIfNeeded(codes, pts) {
        var ez = first(codes, 230, 1);
        if (ez < 0) for (var i = 0; i < pts.length; i++) pts[i] = { x: -pts[i].x, y: pts[i].y };
        return pts;
    }

    function entityToPaths(ent, ctx, out, xf, depth) {
        var c = ent.codes, layer = firstStr(c, 8, '0'), r;
        var push = function (pts, closed) {
            if (!pts || pts.length < 2) return;
            out.push({ points: pts.map(xf), layer: layer, closed: !!closed });
        };
        switch (ent.type) {
            case 'LINE':
                push([{ x: first(c, 10, 0), y: first(c, 20, 0) }, { x: first(c, 11, 0), y: first(c, 21, 0) }]);
                break;
            case 'LWPOLYLINE': {
                var verts = [], cur = null;
                for (var i = 0; i < c.length; i++) {
                    var k = c[i][0], v = parseFloat(c[i][1]);
                    if (k === 10) { cur = { x: v, y: 0, bulge: 0 }; verts.push(cur); }
                    else if (k === 20 && cur) cur.y = v;
                    else if (k === 42 && cur) cur.bulge = v;
                }
                var closed = (first(c, 70, 0) & 1) === 1;
                push(mirrorIfNeeded(c, polyWithBulge(verts, closed)), closed);
                break;
            }
            case 'POLYLINE': {
                var pf = first(c, 70, 0);
                if (pf & (16 | 64)) break; // 3D 網格 / 多面網格：略過
                var closedP = (pf & 1) === 1;
                push(mirrorIfNeeded(c, polyWithBulge(ent.vertices || [], closedP)), closedP);
                break;
            }
            case 'CIRCLE':
                r = first(c, 40, 0);
                if (r > 0) push(mirrorIfNeeded(c, arcPoints(first(c, 10, 0), first(c, 20, 0), r, 0, TAU)), true);
                break;
            case 'ARC':
                r = first(c, 40, 0);
                if (r > 0) push(mirrorIfNeeded(c, arcPoints(first(c, 10, 0), first(c, 20, 0), r,
                    first(c, 50, 0) * Math.PI / 180, first(c, 51, 360) * Math.PI / 180)));
                break;
            case 'ELLIPSE': {
                var e = ellipsePoints(c);
                push(e.pts, e.closed);
                break;
            }
            case 'SPLINE': {
                var sp = splinePoints(c);
                push(sp.pts, sp.closed);
                break;
            }
            case 'INSERT': {
                if (depth > 16) break;
                var name = firstStr(c, 2, ''), blk = ctx.blocks[name];
                if (!blk) break;
                var ix = first(c, 10, 0), iy = first(c, 20, 0);
                var sx = first(c, 41, 1), sy = first(c, 42, 1);
                var rot = first(c, 50, 0) * Math.PI / 180;
                var cols = Math.max(1, first(c, 70, 1)), rows = Math.max(1, first(c, 71, 1));
                var cs = first(c, 44, 0), rs = first(c, 45, 0);
                var ezI = first(c, 230, 1);
                var cr = Math.cos(rot), sr = Math.sin(rot);
                for (var ci = 0; ci < cols; ci++) {
                    for (var ri = 0; ri < rows; ri++) {
                        (function (ox, oy) {
                            var inner = function (p) {
                                var x = (p.x - blk.bx) * sx, y = (p.y - blk.by) * sy;
                                x += ox; y += oy;
                                var X = ix + x * cr - y * sr, Y = iy + x * sr + y * cr;
                                if (ezI < 0) X = -X;
                                return xf({ x: X, y: Y });
                            };
                            blk.ents.forEach(function (be) { entityToPaths(be, ctx, out, inner, depth + 1); });
                        })(ci * cs, ri * rs);
                    }
                }
                break;
            }
        }
    }

    // 把 POLYLINE 後面的 VERTEX/SEQEND 收進 POLYLINE.vertices
    function attachVertices(ents) {
        var out = [];
        for (var i = 0; i < ents.length; i++) {
            var e = ents[i];
            if (e.type === 'POLYLINE') {
                e.vertices = [];
                while (i + 1 < ents.length && ents[i + 1].type === 'VERTEX') {
                    var vc = ents[++i].codes;
                    var vf = first(vc, 70, 0);
                    if (vf & 16) continue; // spline frame control point
                    e.vertices.push({ x: first(vc, 10, 0), y: first(vc, 20, 0), bulge: first(vc, 42, 0) });
                }
                if (i + 1 < ents.length && ents[i + 1].type === 'SEQEND') i++;
            }
            out.push(e);
        }
        return out;
    }

    function parse(text) {
        var pairs = readPairs(text);
        var sections = {}, insunits = 0;
        for (var h = 0; h + 1 < pairs.length; h++) {
            if (pairs[h][0] === 9 && pairs[h][1] === '$INSUNITS') { insunits = parseInt(pairs[h + 1][1], 10) || 0; break; }
            if (pairs[h][0] === 0 && pairs[h][1] === 'ENDSEC') break;
        }
        for (var i = 0; i < pairs.length; i++) {
            if (pairs[i][0] === 0 && pairs[i][1] === 'SECTION' && pairs[i + 1] && pairs[i + 1][0] === 2) {
                var name = pairs[i + 1][1].toUpperCase(), s = i + 2, j = s;
                while (j < pairs.length && !(pairs[j][0] === 0 && pairs[j][1] === 'ENDSEC')) j++;
                sections[name] = [s, j];
                i = j;
            }
        }

        var ctx = { blocks: {} };
        if (sections.BLOCKS) {
            var bents = attachVertices(splitEntities(pairs, sections.BLOCKS[0], sections.BLOCKS[1]));
            var curB = null;
            bents.forEach(function (e) {
                if (e.type === 'BLOCK') {
                    curB = { bx: first(e.codes, 10, 0), by: first(e.codes, 20, 0), ents: [] };
                    ctx.blocks[firstStr(e.codes, 2, '')] = curB;
                } else if (e.type === 'ENDBLK') {
                    curB = null;
                } else if (curB) {
                    curB.ents.push(e);
                }
            });
        }

        var ents;
        if (sections.ENTITIES) ents = splitEntities(pairs, sections.ENTITIES[0], sections.ENTITIES[1]);
        else ents = splitEntities(pairs, 0, pairs.length); // 沒有 SECTION 的簡易檔
        ents = attachVertices(ents);

        var paths = [], id = function (p) { return p; };
        ents.forEach(function (e) {
            // 略過不可見圖層 / paper space
            if (first(e.codes, 67, 0) === 1) return;
            entityToPaths(e, ctx, paths, id, 0);
        });
        return { paths: paths, insunits: insunits };
    }

    window.GordixDXF = { parse: parse };
})();
