const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const IMPORT_FILE = path.join(__dirname, 'nav-import.json');
const TARGET_DB = path.join(__dirname, 'database', 'nav.db');

function all(db, sql, params = []) {
  return new Promise((resolve, reject) =>
    db.all(sql, params, (e, rows) => e ? reject(e) : resolve(rows))
  );
}
function get(db, sql, params = []) {
  return new Promise((resolve, reject) =>
    db.get(sql, params, (e, row) => e ? reject(e) : resolve(row))
  );
}
function run(db, sql, params = []) {
  return new Promise((resolve, reject) =>
    db.run(sql, params, function(e) { e ? reject(e) : resolve(this); })
  );
}

async function main() {
  if (!fs.existsSync(IMPORT_FILE)) throw new Error('找不到 nav-import.json');
  if (!fs.existsSync(TARGET_DB)) throw new Error('找不到 database/nav.db，请确认项目目录正确');

  const data = JSON.parse(fs.readFileSync(IMPORT_FILE, 'utf8'));
  const db = new sqlite3.Database(TARGET_DB);

  try {
    await run(db, 'PRAGMA foreign_keys = ON');
    await run(db, 'BEGIN');

    const menuMap = {};
    const subMap = {};
    let menusAdded = 0, subsAdded = 0, cardsAdded = 0, cardsSkipped = 0;

    // 一级菜单：按名称匹配
    for (const m of data.menus) {
      let row = await get(db, 'SELECT id FROM menus WHERE name=? LIMIT 1', [m.name]);
      if (!row) {
        const r = await run(db, 'INSERT INTO menus(name,"order") VALUES(?,?)', [m.name, m.order ?? 0]);
        menuMap[m.id] = r.lastID;
        menusAdded++;
      } else {
        menuMap[m.id] = row.id;
      }
    }

    // 二级菜单：按父菜单+名称匹配
    for (const s of data.sub_menus) {
      const parent = menuMap[s.parent_id];
      if (!parent) {
        console.warn(`跳过二级菜单：找不到父菜单 ${s.name}`);
        continue;
      }
      let row = await get(
        db,
        'SELECT id FROM sub_menus WHERE parent_id=? AND name=? LIMIT 1',
        [parent, s.name]
      );
      if (!row) {
        const r = await run(
          db,
          'INSERT INTO sub_menus(parent_id,name,"order") VALUES(?,?,?)',
          [parent, s.name, s.order ?? 0]
        );
        subMap[s.id] = r.lastID;
        subsAdded++;
      } else {
        subMap[s.id] = row.id;
      }
    }

    // 网站：URL 去重
    for (const c of data.cards) {
      const menuId = c.menu_id == null ? null : menuMap[c.menu_id];
      const subId = c.sub_menu_id == null ? null : subMap[c.sub_menu_id];

      if (c.menu_id != null && !menuId) {
        console.warn(`跳过：${c.title}，找不到一级菜单`);
        continue;
      }
      if (c.sub_menu_id != null && !subId) {
        console.warn(`跳过：${c.title}，找不到二级菜单`);
        continue;
      }

      const exists = await get(db, 'SELECT id FROM cards WHERE url=? LIMIT 1', [c.url]);
      if (exists) {
        cardsSkipped++;
        continue;
      }

      await run(db, `
        INSERT INTO cards
        (menu_id, sub_menu_id, title, url, logo_url, custom_logo_path, desc, "order")
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        menuId ?? null,
        subId ?? null,
        c.title,
        c.url,
        c.logo_url || '',
        c.custom_logo_path || null,
        c.desc || '',
        c.order ?? 0
      ]);
      cardsAdded++;
    }

    await run(db, 'COMMIT');

    console.log('\n========== 导入完成 ==========');
    console.log(`新增一级菜单: ${menusAdded}`);
    console.log(`新增二级菜单: ${subsAdded}`);
    console.log(`新增网站: ${cardsAdded}`);
    console.log(`跳过重复网站: ${cardsSkipped}`);
    console.log('================================\n');
  } catch (e) {
    try { await run(db, 'ROLLBACK'); } catch {}
    throw e;
  } finally {
    db.close();
  }
}

main().catch(e => {
  console.error('导入失败:', e.message);
  process.exit(1);
});
