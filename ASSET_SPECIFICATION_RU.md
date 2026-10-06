# SEEKER: TD — спецификация СТАТИЧНЫХ ассетов

Версия 2.0 · 4 октября 2026 · ТЗ для художника.

## 1. Границы заказа

Только статичные изображения, отдельные части объектов и метаданные сборки. Анимацию выполняет разработчик программно: повороты, походка, отдача, раскрытие, полёт, цепные лучи, взрывы и распад.

НЕ нужны покадровые анимации, sprite sheets, GIF/видео, аудио, музыка, анимированные эффекты, риги или 3D-модели. Не рисовать каждую фазу движения. Изготовить пригодные к движению независимые части.

Игра для Seeker: башни строят лабиринт, квадратная сетка, один вход и выход, постоянной дороги нет. Режимы Waves/Timed/Endless; Practice/Standard/Ranked. Все тексты интерфейса английские, выводятся кодом. Эргономика важнее детализации.

Обязательный набор: 12 башен, 10 обычных мобов + 1 босс, снаряды, статичные компоненты FX, окружение, меню, иконки и branding. Новые игровые способности — планируемый контент, не уже реализованные функции.

## 2. Художественный стандарт

Смесь оригами и вырезанных картонок: детская ручная сборка с профессионально читаемыми силуэтами. Матовая цветная бумага, сгибы, нахлёсты, немного неровные края, видимые торцы. Башни преимущественно картонные, существа бумажные. Без металлического блеска, пластика, фотореализма, неона, пиксель-арта и простых геометрических маркеров вместо персонажей.

| Назначение | HEX |
|---|---|
| Основная бумага | #F6F5F0 |
| Светлый картон | #E8E8E3 |
| Контуры / карандаш | #595959 |
| Тёмные мелкие детали | #2B2B2B |
| Пушки — dusty peach | #CFA999 |
| Лазеры — paper blue | #A8BBC8 |
| Взрывные — ochre | #D1BF8E |
| Клей / лечение — sage | #A9BBA3 |
| Портал / поддержка — lavender | #B8AAC4 |
| Опасность — muted coral | #C99188 |

Оттенки утверждаются на первом образце. Слабая фактура без грязи. Цвет дополняет силуэт, не заменяет его. Материал — складная бумага и картон; лабиринт и оружие должны быть ясно читаемы. Только оригинальный арт.

Поле сверху с небольшой условной глубиной, НЕ изометрическая сетка. Дизайн поворотных частей выдерживает вращение в плоскости. Главная диорама может быть изометрической. Свет сверху слева; падающие тени отдельными файлами, не запечены в поворотные детали. Локальные сгибы/затенение материала допустимы.

## 3. Масштаб и экспорт

12 колонок, ориентир клетки 30–36 логических px. Проверить каждый объект в клетке 34 и 28 px. Основание башни занимает 75–85% клетки; обычный моб 50–70%, босс до 110%. Не перекрывать соседние клетки длинными деталями. Видимый размер не определяет логический hitbox.

Иконки читаются при 24–28 px; hitbox кнопок минимум 48×48 dp создаёт код. Не рисовать рамку телефона, чёлку, системную полоску или декоративную рамку поля. Не запекать HP, цены, уровни, таймеры, радиусы, текст и выделение в модели.

| Категория | Мастер | Runtime |
|---|---|---|
| Башни: части / preview | 512×512 | 256×256 |
| Обычные мобы: части / preview | 256×256 | 128×128 |
| Босс: части / preview | 512×512 | 256×256 |
| Снаряды / мелкие частицы | 128×128 | 64×64 |
| FX-элементы | 256×256 | 128×128 |
| Большие FX-элементы | 512×512 | 256×256 |
| UI-иконки | SVG + 128×128 | 128×128 |
| Бесшовные текстуры | 1024×1024 | 1024×1024 |

Исходники PSD/KRA/Affinity/SVG со слоями. PNG RGBA, sRGB, прозрачный фон, без белого ореола. Все части одной модели на ОДИНАКОВОМ полном холсте в собранной нейтральной позе. Не обрезать части независимо. Дорисовать скрытые участки под суставами с перекрытием, чтобы при движении не было дыр.

Передать assembled preview и схему слоёв. Для перекраски: нейтральный материал + grayscale masks корпуса/акцента; не только цветной финальный PNG. Атласы и анимации собирает разработчик.

Metadata JSON/таблица: ID, canvas size, file, parent, layer order, pivot каждой детали, sockets соединений и muzzle. Начало координат сверху слева, X вправо/Y вниз; координаты в мастер-px. Runtime координаты масштабируются пропорционально. Башни направлены вверх, угол 0; положительный поворот по часовой стрелке.

Пример, координаты условные:

```json
{"id":"canon","canvas":[512,512],"parts":[
  {"file":"base.png","parent":null,"pivot":[256,280],"order":0},
  {"file":"turret.png","parent":"base","pivot":[256,280],"order":1},
  {"file":"barrel.png","parent":"turret","pivot":[256,250],"order":2}
],"sockets":{"muzzle":{"part":"barrel","position":[256,105]}}}
```

## 4. Башни — 12 сборных конструкций

Каждая: base, turret/mechanism, отдельные подвижные детали, shadow, assembled preview, icon, metadata. Не дублировать независимые детали внутри других слоёв. ID сохраняются как в игре; видимое имя Cannon не Canon.

| ID / имя | Конструкция | Независимые детали |
|---|---|---|
| canon / Cannon | Пьедестал, одна бумажная трубка | Turret, barrel, muzzle cap |
| dualCanon / Dual Cannon | Широкая станина, двустволка, перемычка | Turret, left/right barrel, два muzzle sockets |
| machineGun / Machine Gun | Приземистая турель, барабан, длинный кожух | Barrel, feed drum, bolt |
| simpleLaser / Simple Laser | Опора, один складной отражатель | Lens, reflector flap, emitter |
| bouncingLaser / Bouncing Laser | Несколько гранёных отражателей | Central lens, 3 reflector flaps |
| straightLaser / Straight Laser | Призма в усиленной раме | Prism, две створки, emitter |
| mortar / Mortar | Трапециевидная станина, короткая трубка | Rotating cradle, barrel, muzzle |
| mineLayer / Mine Layer | Коробчатый диспенсер, магазин мин | Hatch, feed tray, mine, discharge socket |
| rocketLauncher / Rocket Launcher | Блок 2×2 бумажных труб | Rotating block, 4 launch sockets; ракета отдельно |
| glueTower / Glue Tower | Бак с кольцевым распылителем | Tank, spray ring, nozzle |
| glueGun / Glue Gun | Усиленный бак и направленная форсунка | Tank, rotating nozzle, hose с перекрытиями |
| teleporter / Teleporter | Складное кольцо-портал | Pedestal, 6 ring segments, inner disc |

Каждый тир имеет другую конструкцию, не просто другой цвет/кольцо. Разработчик анимирует наведение, отдачу, затвор, раскрытие и сжатие.

Для каждого варианта: 2 статичные съёмные enhancement детали (накладка/распорка/хомут) со sockets, всего 24. Код включает их по группам уровней. Не рисовать цифры и фазы апгрейда.

Для всех 12 моделей: маски корпуса/акцента. Дополнительно 2 цветовые палитры на семейство, всего 8 палитр с таблицей HEX и preview. Не заказывать новые модели для простой перекраски. Сложные скины отдельно.

## 5. Мобы — 10 обычных + босс

Общий контракт: body, head, limbs/appendages, особый предмет, shadow, assembled preview, bestiary portrait 128. Гуманоиды: body/head/arm_left/arm_right/leg_left/leg_right. Суставы дорисованы с перекрытием.

Основная статичная front конструкция слегка сверху, лицо к нижнему краю холста. Также back конструкция, если вид спины существенно отличается. Это статичные сборки, НЕ кадры движения. Промежуточные повороты/наклоны делает код. Не заказывать 8 направлений заранее; необходимость боковой сборки проверяется на первом интегрированном образце.

| ID / имя | Образ / акцент | Дополнительные части |
|---|---|---|
| soldier / Soldier | Картонный человечек со шлемом, peach | Helmet, bag |
| blob / Paper Blob | Комок мятой бумаги с глазами, lavender | Core, 3 paper lobes, face; без ног |
| sprinter / Sprinter | Длинноногий оригами-зверёк, ochre | Body, head, 4 legs, tail |
| brute / Brute | Многослойный великан, sage/gray | Гуманоидные части, shoulder plates |
| shieldbearer / Shieldbearer | Фигурка с большим щитом, blue | Гуманоидные части, shield, shield flap |
| flyer / Flyer | Оригами-птица, blue | Body, head, 2 wings, tail, отдельная ground shadow |
| healer / Healer | Фигурка с фонарём, sage | Гуманоидные части, lantern, 2 lantern flaps |
| splitter / Splitter | Кокон с явным швом, peach/lavender | Core, shell_left/right, face |
| swarm / Paper Mite | Маленький жучок, ochre | Body, head, 6 legs; также дочерний моб |
| support / Standard Bearer | Фигурка с флагом, lavender | Гуманоидные части, pole, flag, 2 folds |
| boss / Warlord | Командир с короной и панцирем, charcoal/coral | Гуманоидные части, crown, 3 armor plates, cape из 2 частей |

Походку, взмахи, жесты, реакцию на удар и распад анимирует разработчик. Никаких walk/hit/death/cast кадров.

Каждому обычному типу: base/advanced/elite палитры, masks, 2 съёмные детали (заплата/эмблема/складка). Runtime scale ориентировочно 1.0/1.04/1.08, максимум 1.12 после проверки. Не перерисовывать всё для каждого размера/цвета. Разные роли сохраняют разные силуэты. Существующий Blob входит в десятку, не заменяется случайно новым типом.

## 6. Снаряды и статичные FX

Снаряды вверх, pivot и leading tip отмечены. Полёт/траектория/контакт/время урона делает код. Все элементы ниже — ОДИН статичный рисунок, не последовательность.

| ID | Холст | Изображение |
|---|---|---|
| projectile_cannon | 128 | Бумажный заряд |
| projectile_dual | 128 | Заряд с двойной полоской |
| projectile_machine | 128 | Бумажная игла |
| projectile_mortar | 128 | Плотный бумажный шар |
| projectile_rocket | 128 | Ракета со складными стабилизаторами |
| mine | 128 | Диск, лепестки/индикатор отдельно |
| projectile_glue | 128 | Вязкая пастельная капля |
| beam_simple_strip | 256×64 | Горизонтальная узкая полоса |
| beam_chain_strip | 256×64 | Полоса для сегментов цепной атаки |
| beam_pierce_strip | 256×64 | Полоса плотного пробивающего луча |

Для beam полос обозначить tile/stretch участки. Цели и длину цепи не запекать. Цепь соединяет фактические цели, splash раскрывается в области, slow отображается на мобе — всё собирает разработчик.

Библиотека FX-частей (256×256, кроме указанного):

- muzzle_small, muzzle_heavy — бумажные вспышки.
- hit_bullet_mark, hit_laser_mark, chain_contact — разные контакты.
- explosion_petal_01..04 — 4 раскрываемых лепестка, мастер 512.
- smoke_puff_01..03 — 3 матовых облачка.
- paper_scrap_01..12 — 12 клочков/осколков, мастер 128, masks.
- dust_mark, rocket_exhaust — пыль и выхлоп.
- glue_splat_01..03, glue_spray_drop, slow_ribbon — клей и замедление.
- heal_spark, heal_symbol — лечение, sage.
- shield_contact — удар по щиту.
- buff_ribbon, buff_symbol — усиление, отличается от лечения.
- portal_ring, portal_inner, portal_fold_segment — портал.
- build_fold_piece, upgrade_fold_piece — складные накладки.

Статичные status icons SVG/128: slow_status, heal_status, buff_status, armor_status. Круги радиуса, трассеры, линии маршрута и HP-overlay рисуются кодом. Не нужны готовые взрывы, teleport кадры, fullscreen flashes и десятки кругов разных размеров.

## 7. Окружение

| ID | Размер | Содержание |
|---|---|---|
| paper_field | 1024 tileable | Cream, слабое волокно, без сетки/дороги |
| paper_cardboard | 1024 tileable | Нейтральный картон |
| paper_colored | 1024 tileable | Нейтральная фактура для tint |
| entry_gate | 512 parts | Рама, left/right flaps, shadow |
| exit_goal | 512 parts | Paper body, 2 fold details, shadow |
| shadow_tower / shadow_mob / shadow_flyer | 256 каждый | Мягкие тени |
| path_arrow | SVG/128 | Временная preview стрелка |
| tile_valid / tile_invalid / tile_selected | SVG/128 | Overlays с символом, не только цветом |

Не рисовать украшения, похожие на непроходимые клетки. Сетка, путь и range preview кодовые. Вход и выход ясно различаются.

## 8. Меню и иконки

Сохраняются Home Iso Hero, Armory ISO Pedestal, Leaderboard Podium топ-5, HUD Editorial Strip. Никакой телефонной имитации.

Иллюстрации:

- home_hero 1600×1000: диорама бумажного лабиринта, раздельные base/towers/mobs/shadows; без текста, CH.3 и Earn SOL.
- armory_pedestal 512: пустой постамент, башни отдельно.
- leaderboard_podium 1200×600: 5 отдельных мест; имена, номера, аватары выводятся кодом.
- results_success/results_defeat 800×600 каждый, без текста.
- tutorial_build/tutorial_upgrade/tutorial_path 800×600 каждый, без текста.

Иконки SVG + PNG 128, единый optical size, читаемость 24 px. ID: play, home, tasks, armory, leaderboard, wallet, referral, daily_bonus, buy_runs, settings, back, close, pause, resume, speed, sound_on, sound_off, music_on, music_off, upgrade, sell, target_first, target_last, target_strongest, target_weakest, target_closest, info, lock, check, copy, share, refresh, offline, online, warning, retry, credits, std, sol, life, run_ticket, wave, timer, prize_pool, practice, standard, ranked, waves_mode, timed_mode, endless_mode, repair, supply, voucher.

SOL — разрешённый официальный логотип с источником/лицензией; STD — отдельный оригинальный символ закрытой валюты, не SOL.

Также: boss_warning 256; 5 rank_badges 256; 6 achievement_badges 256 (First Build, First Upgrade, Wave Survivor, Clean Wave, Maze Maker, Boss Slayer); 8 paper_avatars 256. Без bitmap текста. Состояния кнопок/спиннер кодовые.

Для согласования только 2 статичных mockup: Home и бой с full-width нижней Upgrade панелью. Не требуется редизайн всех экранов. Текст в макетах английский, отдельными редактируемыми слоями, не включён в runtime background.

## 9. Предметы и опциональный набор

Обязательные статичные концепты 256: paper_reward_pack (box/lid/inner отдельно), repair_kit, supply_pack, workshop_voucher. Пакет — бумажный конверт/коробка, не металлический сундук. Дроп ещё обсуждается; открытие кодовое.

Опционально, отдельная смета после подтверждения: prototype_tower (base/blades/hub/shadow бумажной турбины); extra_time (бумажные часы); 3 альтернативные field textures; 4 avatar frames; 3 cosmetic trail parts; новые боссы/модельные скины. Не выдавать эти механики за уже утверждённые.

## 10. Branding

- app_icon 1024: бумажная башня/TD знак, без мелких надписей.
- Android adaptive foreground 432 transparent + background 432 opaque; критический символ в центральной области 264×264, проверить circle/squircle.
- monochrome_icon SVG + PNG 432.
- splash_logo 1024 transparent, цвет фона отдельно.
- wordmark SEEKER: TD SVG + PNG 1600×400.

Density exports делает разработчик. Store screenshots/видео вне заказа.

## 11. Поставка

```text
seeker_td_static_assets/
  README.md
  manifest.json
  licenses/
  sources/
  exports/master/
    towers/<tower_id>/
    mobs/<mob_id>/front/
    mobs/<mob_id>/back/
    projectiles/
    fx_parts/
    environment/
    ui/icons/
    ui/illustrations/
    cosmetics/
    branding/
  exports/runtime/
  previews/
```

Файлы lower_snake_case; IDs моделей как в таблицах. Пример towers/dualCanon/barrel_left.png. Manifest: файлы, canvas, parent/order/pivot/sockets, masks, palettes. README: сборка и недостающие элементы. Previews только статичные контактные листы/assembled изображения. Права и лицензии документируются; передача исходников обязательна.

## 12. Производство и приёмка

1. Образец: три тира Cannon частями, Soldier и Blob частями, пуля/вспышка/поле; контактный лист при 34/28 px, static mockup.
2. Разработчик собирает и анимирует, проверяем на Seeker; до утверждения не производить весь набор.
3. Остальные 9 башен, enhancement части и masks.
4. Остальные 8 мобов, босс, вариации.
5. Снаряды/FX/окружение/UI/branding.
6. Правки после интеграции, проверка комплектности.

Критерии: силуэты узнаваемы в маленьком размере; тиры отличаются конструкцией; суставы не дают дыр; pivots/muzzle корректны; тень не вращается со стволом; alpha чистая, фактура не шумит; preview/поле/Armory едины; ничего не скрывает маршрут. Нет запечённой статистики и имитации телефона.

Итоговый заказ — статичные сборочные детали и изображения. НЕТ обязательных анимационных кадров, звуков, FPS/event timelines. Вся анимация, эффекты в движении и звук — работа разработчика.
