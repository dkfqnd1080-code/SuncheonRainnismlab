// =============================================================================
// 합천 2020 홍수: Sentinel-1 SAR · 침수흔적도 · 신고피해 공간적 일치성 분석 (Google Earth Engine)
// 파트 5/5 — DEM 지형 분석 (HAND · 경사 · 침수심)
// -----------------------------------------------------------------------------
// SAR 침수 후보의 지형 타당성(HAND, 경사, 레이더 그림자)과 B 필지 침수심을 2020년 지침 기준과 비교
// 선행 파일: 01, 03 (dsgAssetInfo, DAMAGE_ASSET_ID 등 사용)
//
// 실행 방법: GEE Code Editor에서 01 → 05 파일을 순서대로 하나의 스크립트에 이어 붙여 실행한다.
//           (GEE 스크립트는 파일끼리 변수를 공유하지 않으므로 파일 하나만 따로 실행하면 오류가 난다.)
// =============================================================================

// =============================================================================
// [추가 3] DEM 지형 분석 — 원본 코드는 한 줄도 바꾸지 않는다
// -----------------------------------------------------------------------------
// 이 블록은 파일 맨 끝에 붙어서, 원본 분석이 모두 끝난 뒤에 실행된다.
// 원본 함수 안의 변수(dsgParcelCases, sImage, gImage, changeClass)는 함수 밖에서 볼 수 없으므로
// 원본과 똑같은 방법·같은 설정값으로 이 블록 안에서 다시 만든다.
// → 콘솔의 '[DEM] A·B 필지 수'가 원본 D/S/G 8단계 값과 같으면 제대로 재현된 것이다.
//
// 이 블록이 답하는 질문
//   Q1. SAR 침수 후보가 물이 고일 수 있는 지형(평탄하고 하천보다 많이 높지 않은 곳)에 있는가?
//   Q2. 레이더 반대쪽 산 경사면이 어둡게 찍혀 침수로 잡힌 것은 아닌가?
//   Q3. B 놓친 부분(신고 + SAR, 흔적도 밖) 논의 침수심은 2020년 지침 농경지 기준과 비교해 어떤가?
//       방법 ① SAR 침수 가장자리의 DEM 고도로 수면고를 추정 (FwDET 단순화)
//       방법 ② 용역보고서의 공식 침수위(가장 가까운 흔적도 지구)를 수면고로 사용
//
// 적용 기준: 행정안전부 고시 제2020-14호 「재해지도 작성 기준 등에 관한 지침」 1-2-1 ③ 농경지
//   "침수심이 0.7m 이상 발생된 지역을 대상으로 하되 1m 이하인 경우에는
//    지방자치단체장이 피해상황을 고려하여 결정"
//   → 0.7 m 미만: 기준 미만 / 0.7~1.0 m: 지자체장 판단 / 1.0 m 초과: 작성 대상
// =============================================================================

if (dsgAssetInfo) {
  runDemAnalysis();
} else {
  print('===== [DEM] 신고피해 필지 asset이 없어 DEM 분석을 건너뜁니다 =====');
}

function runDemAnalysis() {
  // ---------------------------------------------------------------------------
  // 0. 설정
  // ---------------------------------------------------------------------------
  // DEM 출처
  //   'COP30' : Copernicus GLO-30 (GEE에 바로 있음, 30 m). 건물·수목 높이가 일부 섞인 DSM이다.
  //   'ASSET' : 직접 올린 DEM. 국토지리정보원 5 m 수치표고모델을 GeoTIFF로 올려 쓰면
  //             침수심 추정 정확도가 크게 좋아진다.
  var DEM_SOURCE = 'COP30';
  var DEM_ASSET_ID = 'projects/flood1-507003/assets/Hapcheon_DEM_5m';  // 'ASSET'일 때만 사용

  // Q1. 지형상 침수 가능 지역 = 경사 ≤ SLOPE_MAX_DEG 그리고 HAND ≤ HAND_MAX_M
  var SLOPE_MAX_DEG = 5;
  var HAND_MAX_M = 15;
  var HAND_SENSITIVITY_M = [5, 10, 15, 20];

  // Q2. 국지입사각(LIA)
  var LIA_BACKSLOPE_DEG = 60;  // 이 이상이면 레이더 반대쪽 경사면(평지보다 어둡게 찍힘)
  // 레이더가 바라보는 방위각(북 = 0°, 시계방향). 합천(북위 약 35.5°) 부근 근사값.
  //   DESCENDING: 진행 방향 약 193° + 오른쪽 관측 90° = 약 283° (위성은 동쪽에서 서쪽을 바라봄)
  //   ASCENDING : 진행 방향 약 347° + 90° = 약 77°
  var LOOK_AZIMUTH_DEG = (ORBIT_PASS === 'DESCENDING') ? 283 : 77;

  // Q3. 침수심 (2020년 지침 농경지 기준)
  var PADDY_MIN_M = 0.7;      // 0.7 m 이상이 대상
  var PADDY_CLEAR_M = 1.0;    // 1 m 이하는 지자체장 판단 → 1 m 초과는 확실한 대상
  var DEPTH_WINDOW_M = 150;   // 방법 ①: 이 반경 안 SAR 침수 가장자리 고도의 중앙값 = 수면고

  // 방법 ②: 공식 침수위
  //   1순위: 흔적도 polygon의 침수위 속성(지침 부록 기준 F_HGT, EL.m)
  //   2순위: 흔적도의 지구명 속성(F_ZONE_NM)으로 아래 표에서 침수위를 찾음
  //   콘솔의 '흔적도 속성 이름'을 보고 실제 이름이 다르면 아래 두 값을 바꾼다.
  var TRACE_WSE_PROPERTY = 'F_HGT';
  var TRACE_ZONE_PROPERTY = 'F_ZONE_NM';
  // 「합천군 침수흔적도 및 재해정보지도 작성 용역」 측량조사 보고서의 지구별 침수 수위(EL.m)
  // 하신들은 건태 21.8 / 이책 19.6 / 창동 21.0 m 중 중앙값 21.0 m를 쓴다.
  var OFFICIAL_WSE_BY_ZONE = {
    '삼학지구': 16.7, '수변공원': 16.7, '하신들': 21.0, '매호들': 21.7, '매호지구': 21.7,
    '내촌지구': 17.7, '성산들': 15.8, '북동지구': 16.3, '병배지구': 15.4, '율지지구': 12.0,
    '낙민지구': 24.6, '내천지구': 22.4, '율진지구': 28.8, '기리지구': 23.4
  };
  var NEAREST_MAX_DISTANCE_M = 3000;  // 이 거리 안의 가장 가까운 흔적도 polygon 침수위를 쓴다

  // 특정 리만 따로 보기(선택). 예: 율곡면 임북리의 법정동코드 10자리(PNU 앞 10자리).
  // 행정표준코드관리시스템(code.go.kr)에서 확인해 넣는다. 비워 두면 건너뛴다.
  var FOCUS_LI_CODE = '';
  var FOCUS_LABEL = '임북리';

  // 흔적도의 공식 침수심 속성(지침 부록 기준 F_SHIM). 값이 없으면 방법 ① 검증을 건너뛴다.
  var TRACE_DEPTH_PROPERTY = 'F_SHIM';

  // 원본 전후비교와 같은 설정 (new water 재현용)
  var PRE_START = '2020-07-27';
  var PRE_END = '2020-07-28';
  var CHANGE_DB = 3;

  var CROPLAND_CLASS = 40;    // ESA WorldCover Cropland
  var CODE_A = 7;             // D1 S1 G1
  var CODE_B = 6;             // D1 S1 G0
  var RAD = Math.PI / 180;

  // FeatureCollection.select() 대신 쓰는 함수: 지정한 속성만 담아 새 Feature를 만든다.
  // 값이 비어 있는(null) 속성도 그대로 빈칸으로 남는다.
  function keepProperties(collection, propertyNames) {
    return collection.map(function(feature) {
      var properties = {};
      propertyNames.forEach(function(name) {
        properties[name] = feature.get(name);
      });
      return ee.Feature(feature.geometry(), properties);
    });
  }

  print('===== [DEM] 0. 설정 =====');
  print('DEM 출처', DEM_SOURCE === 'ASSET' ? DEM_ASSET_ID : 'COPERNICUS/DEM/GLO30');
  print('지형상 침수 가능 기준',
    '경사 ≤ ' + SLOPE_MAX_DEG + '° 그리고 HAND ≤ ' + HAND_MAX_M + ' m');
  print('침수심 기준 (2020 지침 농경지)',
    PADDY_MIN_M + ' m 이상 대상, ' + PADDY_CLEAR_M + ' m 이하는 지자체장 판단');

  // ---------------------------------------------------------------------------
  // 1. 원본과 같은 방법으로 S · G 영상과 A · B 필지 다시 만들기
  // ---------------------------------------------------------------------------
  var demBase = ee.Image.constant(0)
    .toByte()
    .setDefaultProjection(dsgProjection);

  // 원본 D/S/G 3단계와 같은 정의
  var sImage = sarFlood
    .gt(0)
    .rename('S')
    .toByte()
    .updateMask(validEvaluationMask)
    .clip(roi);
  var gImage = demBase
    .paint({featureCollection: floodTrace, color: 1})
    .rename('G')
    .toByte()
    .updateMask(validEvaluationMask)
    .clip(roi);

  // 원본 D/S/G 1·2단계와 같은 필터: 필지 경계 polygon, PNU 있음, PNU당 1개
  var demParcelsDistinct = ee.FeatureCollection(
    ee.FeatureCollection(DAMAGE_ASSET_ID)
      .filter(ee.Filter.eq('class_type', PARCEL_CLASS_VALUE))
      .map(function(feature) {
        return feature.set('dsg_geometry_type', feature.geometry().type());
      })
      .filter(ee.Filter.inList('dsg_geometry_type', ['Polygon', 'MultiPolygon']))
      .filter(ee.Filter.notNull(['PNU']))
      .distinct('PNU')
  );
  // select() 대신 필요한 속성만 담아 새 Feature를 만든다(원본 D/S/G 2단계와 같은 방식).
  var demParcelsUnique = demParcelsDistinct.map(function(feature) {
    feature = ee.Feature(feature);
    return ee.Feature(feature.geometry(), {PNU: feature.get('PNU')});
  });

  // 원본 D/S/G 6·7·8단계와 같은 겹침 비율·판정 (같은 분모, 같은 overlapThreshold)
  var demOverlapImage = ee.Image.pixelArea()
    .rename('valid_area_m2')
    .updateMask(validEvaluationMask)
    .clip(roi)
    .addBands(sImage.multiply(ee.Image.pixelArea()).rename('sar_area_m2'))
    .addBands(gImage.multiply(ee.Image.pixelArea()).rename('trace_area_m2'));

  var demParcelCases = demOverlapImage.reduceRegions({
    collection: demParcelsUnique,
    reducer: ee.Reducer.sum().forEachBand(demOverlapImage),
    scale: DSG_SCALE,
    crs: dsgProjection,
    tileScale: TILE_SCALE
  }).map(function(feature) {
    var validArea = dsgNumberOrZero(feature, 'valid_area_m2');
    var safeValid = validArea.max(1e-9);
    var sarRatio = dsgNumberOrZero(feature, 'sar_area_m2').divide(safeValid).min(1);
    var traceRatio = dsgNumberOrZero(feature, 'trace_area_m2').divide(safeValid).min(1);
    var sFlag = overlapThreshold === 0 ? sarRatio.gt(0) : sarRatio.gte(overlapThreshold);
    var gFlag = overlapThreshold === 0 ? traceRatio.gt(0) : traceRatio.gte(overlapThreshold);
    return feature.set({
      valid_area_m2: validArea,
      sar_overlap_ratio: ee.Algorithms.If(validArea.gt(0), sarRatio, null),
      trace_overlap_ratio: ee.Algorithms.If(validArea.gt(0), traceRatio, null),
      'case': ee.Algorithms.If(
        validArea.gt(0),
        ee.Number(4).add(sFlag.multiply(2)).add(gFlag),
        null
      )
    });
  });

  var groupA = demParcelCases.filter(ee.Filter.eq('case', CODE_A));
  var groupB = demParcelCases.filter(ee.Filter.eq('case', CODE_B));

  print('===== [DEM] 1. 원본 재현 확인 (원본 D/S/G 8단계 값과 같아야 함) =====');
  print('[DEM] A 필지 수', groupA.size());
  print('[DEM] B 필지 수', groupB.size());

  // 원본 전후비교 1·2단계와 같은 방법으로 new water 다시 만들기
  var changeClass = null;
  var demPreCollection = hapcheonS1
    .filterDate(PRE_START, PRE_END)
    .sort('system:index');
  if (demPreCollection.size().getInfo() > 0) {
    var demPreVV = demPreCollection
      .mosaic()
      .setDefaultProjection(analysisProjection)
      .select('VV')
      .rename('Pre_VV_dB');
    var demPreVVLeeDb = linearPowerToDb(
      leeFilter5x5Linear(dbToLinearPower(demPreVV), evaluationRoi),
      'Pre_VV_Lee_dB'
    );
    var demPrePostValid = validEvaluationMask.and(demPreVVLeeDb.mask().gt(0));
    var demPre = demPreVVLeeDb.rename('pre_vv_db');
    var demPost = floodVVLeeDb.rename('post_vv_db');
    var demDelta = demPost.subtract(demPre);
    var demPostDark = demPost.lte(otsuThreshold);
    var demPreDark = demPre.lte(otsuThreshold);
    changeClass = ee.Image.constant(0)
      .setDefaultProjection(analysisProjection)
      .toByte()
      .where(demPostDark.and(demPreDark.not()).and(demDelta.lte(-CHANGE_DB)), 1)
      .where(demPostDark.and(demPreDark), 2)
      .where(demPostDark.and(demPreDark.not()).and(demDelta.gt(-CHANGE_DB)), 3)
      .updateMask(demPrePostValid)
      .clip(evaluationRoi)
      .rename('change_class');
  } else {
    print('[DEM] 홍수 전 영상이 없어 new water 영역은 건너뜁니다', PRE_START);
  }

  // ---------------------------------------------------------------------------
  // 2. DEM · 경사 · 향 · HAND · 국지입사각
  // ---------------------------------------------------------------------------
  var dem;
  var demProjection;
  if (DEM_SOURCE === 'ASSET') {
    dem = ee.Image(DEM_ASSET_ID).select([0], ['elev_m']);
    demProjection = dem.projection();
  } else {
    var demCollection = ee.ImageCollection('COPERNICUS/DEM/GLO30')
      .filterBounds(evaluationRoi)
      .select(['DEM'], ['elev_m']);
    demProjection = ee.Image(demCollection.first()).projection();
    dem = demCollection.mosaic().setDefaultProjection(demProjection);
  }
  print('===== [DEM] 2. 지형 자료 =====');
  print('DEM 원래 해상도 (m)', demProjection.nominalScale());

  // 고도는 10 m 분석 격자로 부드럽게(bilinear) 옮긴다.
  var elevation = dem.resample('bilinear').rename('elev_m');

  // 경사·향은 DEM 원래 격자에서 계산한다(10 m로 먼저 옮기면 계단 모양 경사가 생긴다).
  var slope = ee.Terrain.slope(dem).reproject(demProjection).rename('slope_deg');
  var aspect = ee.Terrain.aspect(dem).reproject(demProjection).rename('aspect_deg');

  // HAND: 가장 가까운 하천보다 몇 m 높은가. MERIT Hydro, 약 90 m라 좁은 계곡에서는 거칠다.
  var hand = ee.Image('MERIT/Hydro/v1_0_1')
    .select(['hnd'], ['hand_m'])
    .resample('bilinear');

  // 국지입사각(LIA)
  //   cos(LIA) = cos(경사)·cos(입사각) + sin(경사)·sin(입사각)·cos(향 − 위성 쪽 방위각)
  //   경사면이 위성을 향하면 LIA가 작아져 밝게, 등지면 커져 어둡게 찍힌다. 90° 이상은 레이더 그림자.
  var incidence = flood.select('angle').resample('bilinear');
  var toSensorAzimuthRad = ((LOOK_AZIMUTH_DEG + 180) % 360) * RAD;
  var slopeRad = slope.multiply(RAD);
  var incidenceRad = incidence.multiply(RAD);
  var cosLia = slopeRad.cos().multiply(incidenceRad.cos())
    .add(
      slopeRad.sin()
        .multiply(incidenceRad.sin())
        .multiply(aspect.multiply(RAD).subtract(toSensorAzimuthRad).cos())
    );
  var lia = cosLia.clamp(-1, 1).acos().divide(RAD).rename('lia_deg');

  var plausible = slope.lte(SLOPE_MAX_DEG)
    .and(hand.lte(HAND_MAX_M))
    .rename('plausible');

  var terrainImage = ee.Image.cat([
    elevation,
    slope,
    hand,
    lia,
    plausible,
    slope.gt(SLOPE_MAX_DEG).rename('steep'),
    hand.gt(HAND_MAX_M).rename('high_hand'),
    lia.gte(LIA_BACKSLOPE_DEG).rename('backslope'),
    lia.gte(90).rename('shadow')
  ]);
  HAND_SENSITIVITY_M.forEach(function(handMax) {
    terrainImage = terrainImage.addBands(
      slope.lte(SLOPE_MAX_DEG).and(hand.lte(handMax)).rename('plaus_h' + handMax)
    );
  });

  // ---------------------------------------------------------------------------
  // 3. 방법 ① 침수심 추정: SAR 침수 가장자리 고도 = 수면고
  // ---------------------------------------------------------------------------
  // 가장자리 픽셀(침수 후보이면서 이웃에 비침수가 있는 픽셀)의 지반고 ≈ 그때의 수면고.
  // 각 픽셀 주변 DEPTH_WINDOW_M 안 가장자리 고도의 중앙값을 수면고로 쓰고, 침수심 = 수면고 − 지반고.
  // 한계: ROI 경계에서 잘린 가장자리, 반경 안에 높이가 다른 물웅덩이가 섞이면 수면고가 틀어진다.
  var floodBinary = sImage.unmask(0);
  var floodEdge = sImage.eq(1).and(
    floodBinary.focalMin({radius: 1, kernelType: 'square', units: 'pixels'}).eq(0)
  );
  var waterSurface = elevation
    .updateMask(floodEdge)
    .reduceNeighborhood({
      reducer: ee.Reducer.median(),
      kernel: ee.Kernel.circle({radius: DEPTH_WINDOW_M, units: 'meters'}),
      skipMasked: false   // 가장자리가 아닌 픽셀에도 주변 가장자리 고도로 값을 만든다
    })
    .rename('wse_m');
  var depth = waterSurface
    .subtract(elevation)
    .max(0)
    .updateMask(sImage.eq(1))
    .rename('depth_m');

  var depthImage = ee.Image.cat([
    depth,
    depth.lt(PADDY_MIN_M).rename('d_lt07'),
    depth.gte(PADDY_MIN_M).and(depth.lte(PADDY_CLEAR_M)).rename('d_07_10'),
    depth.gt(PADDY_CLEAR_M).rename('d_gt10')
  ]);

  // ---------------------------------------------------------------------------
  // 4. 영역별 지형 · 침수심 요약
  // ---------------------------------------------------------------------------
  function demParcelMask(parcels) {
    return demBase
      .paint({featureCollection: parcels, color: 1})
      .updateMask(validEvaluationMask)
      .clip(evaluationRoi)
      .eq(1);
  }

  var aSarTrace = sImage.eq(1).and(gImage.eq(1)).and(demParcelMask(groupA));
  var bMissed = sImage.eq(1).and(gImage.eq(0)).and(demParcelMask(groupB));
  var cropland = hapcheonWorldCover.eq(CROPLAND_CLASS).unmask(0);

  // 침수심은 계산량이 많아서 A·B 관련 영역에서만 구한다.
  var zones = [
    {label: 'CASE1 TP (SAR & trace)', mask: tp.eq(1), depth: false},
    {label: 'CASE2 FN (trace only)', mask: fn.eq(1), depth: false},
    {label: 'CASE3 Outside-GT (SAR only)', mask: outsideGt.eq(1), depth: false},
    {label: 'A parcels: SAR & trace', mask: aSarTrace, depth: true},
    {label: 'A parcels: SAR & trace, cropland', mask: aSarTrace.and(cropland), depth: true},
    {label: 'B missed area', mask: bMissed, depth: true},
    {label: 'B missed area, cropland', mask: bMissed.and(cropland), depth: true}
  ];
  if (changeClass) {
    zones.push({
      label: 'B missed area, new water',
      mask: bMissed.and(changeClass.eq(1)),
      depth: true
    });
  }
  zones.push({label: 'Whole ROI', mask: validEvaluationMask, depth: false});

  // 평균(0/1 band는 비율) + 10·50·90 백분위 + 픽셀 수
  var zoneReducer = ee.Reducer.mean()
    .combine({reducer2: ee.Reducer.percentile([10, 50, 90]), sharedInputs: true})
    .combine({reducer2: ee.Reducer.count(), sharedInputs: true})
    .unweighted();

  var zoneTable = ee.FeatureCollection(zones.map(function(zone, index) {
    var zoneImage = zone.depth ? terrainImage.addBands(depthImage) : terrainImage;
    var stats = ee.Dictionary(zoneImage.updateMask(zone.mask).reduceRegion({
      reducer: zoneReducer,
      geometry: evaluationRoi,
      scale: EVAL_SCALE,
      crs: analysisProjection,
      maxPixels: MAX_PIXELS,
      tileScale: TILE_SCALE
    }));

    var properties = {
      zone_order: index + 1,
      zone: zone.label,
      has_depth: zone.depth ? 1 : 0,
      pixels: stats.get('slope_deg_count'),
      elev_p10_m: stats.get('elev_m_p10'),
      elev_p50_m: stats.get('elev_m_p50'),
      elev_p90_m: stats.get('elev_m_p90'),
      slope_p50_deg: stats.get('slope_deg_p50'),
      slope_p90_deg: stats.get('slope_deg_p90'),
      hand_p50_m: stats.get('hand_m_p50'),
      hand_p90_m: stats.get('hand_m_p90'),
      lia_p50_deg: stats.get('lia_deg_p50'),
      plausible_share: stats.get('plausible_mean'),
      steep_share: stats.get('steep_mean'),
      high_hand_share: stats.get('high_hand_mean'),
      backslope_share: stats.get('backslope_mean'),
      shadow_share: stats.get('shadow_mean')
    };
    HAND_SENSITIVITY_M.forEach(function(handMax) {
      properties['plausible_share_hand' + handMax] = stats.get('plaus_h' + handMax + '_mean');
    });
    if (zone.depth) {
      properties.depth_pixels = stats.get('depth_m_count');
      properties.depth_p50_m = stats.get('depth_m_p50');
      properties.depth_p90_m = stats.get('depth_m_p90');
      properties.depth_share_under07 = stats.get('d_lt07_mean');
      properties.depth_share_07_10 = stats.get('d_07_10_mean');
      properties.depth_share_over10 = stats.get('d_gt10_mean');
    }
    return ee.Feature(null, properties);
  }));

  print('===== [DEM] 4. 영역별 지형 · 침수심 요약 (share = 0~1 비율) =====');
  print('영역별 결과표', zoneTable);

  // 차트 D1. 영역별 지형 점검
  print(ui.Chart.feature.byFeature({
    features: zoneTable,
    xProperty: 'zone',
    yProperties: ['plausible_share', 'steep_share', 'high_hand_share', 'backslope_share']
  })
    .setChartType('ColumnChart')
    .setOptions({
      title: 'Terrain check by zone (plausible = slope ≤ ' + SLOPE_MAX_DEG +
        '° & HAND ≤ ' + HAND_MAX_M + ' m)',
      hAxis: {title: 'Zone', slantedText: true, slantedTextAngle: 30},
      vAxis: {title: 'Share of pixels in zone', viewWindow: {min: 0, max: 1}},
      series: {
        0: {color: '#2E7D32', labelInLegend: 'Plausible flood terrain'},
        1: {color: '#8D6E63', labelInLegend: 'Slope > ' + SLOPE_MAX_DEG + '°'},
        2: {color: '#FFA000', labelInLegend: 'HAND > ' + HAND_MAX_M + ' m'},
        3: {color: '#6A1B9A', labelInLegend: 'Back-slope (LIA ≥ ' + LIA_BACKSLOPE_DEG + '°)'}
      },
      legend: {position: 'top'},
      bar: {groupWidth: '75%'}
    }));

  // 차트 D2. 방법 ① 추정 침수심 등급 (2020 지침 농경지 기준)
  print(ui.Chart.feature.byFeature({
    features: zoneTable.filter(ee.Filter.eq('has_depth', 1)),
    xProperty: 'zone',
    yProperties: ['depth_share_under07', 'depth_share_07_10', 'depth_share_over10']
  })
    .setChartType('ColumnChart')
    .setOptions({
      title: 'Estimated flood depth class, edge method (' + DEM_SOURCE + ')',
      isStacked: true,
      hAxis: {title: 'Zone', slantedText: true, slantedTextAngle: 20},
      vAxis: {title: 'Share of SAR flood pixels', viewWindow: {min: 0, max: 1}},
      series: {
        0: {color: '#B3E5FC', labelInLegend: '< ' + PADDY_MIN_M + ' m'},
        1: {color: '#42A5F5', labelInLegend: PADDY_MIN_M + '–' + PADDY_CLEAR_M + ' m (local decision)'},
        2: {color: '#0D47A1', labelInLegend: '> ' + PADDY_CLEAR_M + ' m (target)'}
      },
      legend: {position: 'top'},
      bar: {groupWidth: '60%'}
    }));

  // ---------------------------------------------------------------------------
  // 5. 필지 단위: 방법 ① 침수심 + 지형
  // ---------------------------------------------------------------------------
  // 침수심은 필지 안 SAR 침수 픽셀의 중앙값, 지반고는 필지 전체의 중앙값이다.
  var parcelImage = ee.Image.cat([
    depthImage.select(['depth_m', 'd_gt10']),
    terrainImage.select(['elev_m', 'slope_deg', 'hand_m', 'lia_deg', 'plausible'])
  ]);
  var parcelReducer = ee.Reducer.median()
    .combine({reducer2: ee.Reducer.mean(), sharedInputs: true});

  function depthClass(value) {
    return ee.Algorithms.If(
      ee.Algorithms.IsEqual(value, null),
      'no_value',
      ee.Algorithms.If(
        ee.Number(value).gt(PADDY_CLEAR_M),
        'over_1m',
        ee.Algorithms.If(
          ee.Number(value).gte(PADDY_MIN_M),
          'from_07_to_1m',
          ee.Algorithms.If(ee.Number(value).gt(0), 'under_07m', 'above_water')
        )
      )
    );
  }

  function addParcelDem(parcels) {
    return parcelImage.reduceRegions({
      collection: parcels,
      reducer: parcelReducer,
      scale: EVAL_SCALE,
      crs: analysisProjection,
      tileScale: TILE_SCALE
    }).map(function(feature) {
      return feature.set('edge_depth_class', depthClass(feature.get('depth_m_median')));
    });
  }

  var aDem = addParcelDem(groupA);
  var bDem = addParcelDem(groupB);

  print('===== [DEM] 5. 방법 ① 필지 단위 추정 침수심 (SAR 가장자리 고도) =====');
  print('A 필지 등급별 수', aDem.aggregate_histogram('edge_depth_class'));
  print('B 필지 등급별 수', bDem.aggregate_histogram('edge_depth_class'));

  // ---------------------------------------------------------------------------
  // 6. 방법 ② 공식 침수위와 비교: 가장 가까운 흔적도 지구의 침수위 − 필지 지반고
  // ---------------------------------------------------------------------------
  // A 필지(흔적도 안)는 대부분 0 m보다 깊게 나와야 정상이다. 이것이 DEM과 공식 침수위가
  // 서로 맞는지 보는 확인용이다. 그 다음 B 필지가 어느 등급에 드는지 본다.
  // 주의: 공식 침수위(EL.m)는 국내 수직기준, Copernicus DEM은 전지구 지오이드 기준이라
  //       수십 cm 차이가 날 수 있다. 5 m DEM(국내 기준)을 쓰면 이 차이가 줄어든다.
  print('===== [DEM] 6. 방법 ② 공식 침수위와 비교 =====');
  print('흔적도 속성 이름 (침수위·지구명·침수심 속성 확인용)',
    hapcheonPolygonTable.first().propertyNames());

  var referenceTrace = null;
  var wseSourceText = '';
  var traceWithWse = hapcheonPolygonTable.filter(ee.Filter.notNull([TRACE_WSE_PROPERTY]));
  var traceWithWseCount = traceWithWse.size().getInfo();
  var wseType = traceWithWseCount > 0
    ? ee.Algorithms.ObjectType(traceWithWse.first().get(TRACE_WSE_PROPERTY)).getInfo()
    : 'None';

  if (traceWithWseCount > 0 && wseType !== 'String') {
    referenceTrace = traceWithWse.map(function(feature) {
      return feature.set('ref_wse_m', ee.Number(feature.get(TRACE_WSE_PROPERTY)));
    });
    wseSourceText = '흔적도 속성 ' + TRACE_WSE_PROPERTY;
  } else {
    var traceWithZone = hapcheonPolygonTable.filter(ee.Filter.notNull([TRACE_ZONE_PROPERTY]));
    var traceWithZoneCount = traceWithZone.size().getInfo();
    var zoneType = traceWithZoneCount > 0
      ? ee.Algorithms.ObjectType(traceWithZone.first().get(TRACE_ZONE_PROPERTY)).getInfo()
      : 'None';
    if (traceWithZoneCount > 0 && zoneType === 'String') {
      var wseLookup = ee.Dictionary(OFFICIAL_WSE_BY_ZONE);
      var traceMapped = traceWithZone.map(function(feature) {
        return feature.set('ref_wse_m', wseLookup.get(feature.get(TRACE_ZONE_PROPERTY), -9999));
      });
      referenceTrace = traceMapped.filter(ee.Filter.neq('ref_wse_m', -9999));
      wseSourceText = '용역보고서 지구별 침수위 표 (' + TRACE_ZONE_PROPERTY + ' 기준)';
      print('흔적도 지구명 목록 (표에 없는 이름은 OFFICIAL_WSE_BY_ZONE에 추가)',
        traceWithZone.aggregate_array(TRACE_ZONE_PROPERTY).distinct());
      print('공식 침수위를 찾지 못한 흔적도 polygon 수',
        traceMapped.filter(ee.Filter.eq('ref_wse_m', -9999)).size());
    }
  }

  var aOfficial = null;
  var bOfficial = null;
  var officialClasses = ['over_1m', 'from_07_to_1m', 'under_07m', 'above_water'];

  if (referenceTrace === null) {
    print('방법 ② 생략',
      '흔적도에 ' + TRACE_WSE_PROPERTY + '(숫자) 또는 ' + TRACE_ZONE_PROPERTY +
      '(문자) 속성이 없습니다. 위 속성 이름을 보고 TRACE_WSE_PROPERTY·TRACE_ZONE_PROPERTY를 바꾸세요.');
  } else {
    print('공식 침수위 출처', wseSourceText);

    var nearestJoin = ee.Join.saveBest({matchKey: 'ref_trace', measureKey: 'ref_dist_m'});
    var withinFilter = ee.Filter.withinDistance({
      distance: NEAREST_MAX_DISTANCE_M,
      leftField: '.geo',
      rightField: '.geo',
      maxError: 10
    });

    var addOfficialDepth = function(parcelsWithDem) {
      return ee.FeatureCollection(nearestJoin.apply(parcelsWithDem, referenceTrace, withinFilter))
        .map(function(feature) {
          var reference = ee.Feature(feature.get('ref_trace'));
          var wse = ee.Number(reference.get('ref_wse_m'));
          var ground = feature.get('elev_m_median');
          var officialDepth = ee.Algorithms.If(
            ee.Algorithms.IsEqual(ground, null),
            null,
            wse.subtract(ee.Number(ground))
          );
          return feature.set({
            ref_wse_m: wse,
            ref_zone: reference.get(TRACE_ZONE_PROPERTY),
            official_depth_m: officialDepth,
            official_depth_class: depthClass(officialDepth)
          });
        });
    };

    aOfficial = addOfficialDepth(aDem);
    bOfficial = addOfficialDepth(bDem);

    print('침수위를 붙인 필지 수 (A / B, ' + NEAREST_MAX_DISTANCE_M + ' m 안에 흔적도가 있는 것)',
      ee.List([aOfficial.size(), bOfficial.size()]));
    print('A 필지 공식 침수위 기준 침수심 중앙값 (m) — 확인용, 0보다 커야 정상',
      aOfficial.reduceColumns(ee.Reducer.median(), ['official_depth_m']).get('median'));
    print('B 필지 공식 침수위 기준 침수심 중앙값 (m)',
      bOfficial.reduceColumns(ee.Reducer.median(), ['official_depth_m']).get('median'));
    print('A 필지 등급별 수 (공식 침수위)', aOfficial.aggregate_histogram('official_depth_class'));
    print('B 필지 등급별 수 (공식 침수위)', bOfficial.aggregate_histogram('official_depth_class'));
    print('B 필지가 참조한 흔적도 지구', bOfficial.aggregate_histogram('ref_zone'));

    var officialSummary = ee.FeatureCollection([
      ['A parcels (inside trace)', aOfficial],
      ['B parcels (outside trace)', bOfficial]
    ].map(function(pair) {
      var properties = {group: pair[0], n_parcels: pair[1].size()};
      officialClasses.forEach(function(className) {
        properties[className] = pair[1].filter(ee.Filter.eq('official_depth_class', className)).size();
      });
      return ee.Feature(null, properties);
    }));

    // 차트 D3. 공식 침수위 기준 침수심 등급 (A vs B)
    print(ui.Chart.feature.byFeature({
      features: officialSummary,
      xProperty: 'group',
      yProperties: officialClasses
    })
      .setChartType('ColumnChart')
      .setOptions({
        title: 'Depth from official flood level of nearest trace zone − parcel ground (' + DEM_SOURCE + ')',
        isStacked: 'percent',
        hAxis: {title: 'Group'},
        vAxis: {title: 'Share of parcels', format: '#%'},
        series: {
          0: {color: '#0D47A1', labelInLegend: '> ' + PADDY_CLEAR_M + ' m (target)'},
          1: {color: '#42A5F5', labelInLegend: PADDY_MIN_M + '–' + PADDY_CLEAR_M + ' m (local decision)'},
          2: {color: '#B3E5FC', labelInLegend: '0–' + PADDY_MIN_M + ' m'},
          3: {color: '#BDBDBD', labelInLegend: 'Ground above flood level'}
        },
        legend: {position: 'top'},
        bar: {groupWidth: '50%'}
      }));

    // 특정 리(예: 임북리)만 따로 보기
    if (FOCUS_LI_CODE !== '') {
      var focusB = bOfficial.filter(ee.Filter.stringStartsWith('PNU', FOCUS_LI_CODE));
      print('===== [DEM] 6-1. ' + FOCUS_LABEL + ' B 필지 =====');
      print(FOCUS_LABEL + ' B 필지 수', focusB.size());
      print(FOCUS_LABEL + ' 공식 침수위 기준 등급별 수', focusB.aggregate_histogram('official_depth_class'));
      print(FOCUS_LABEL + ' 방법 ① 등급별 수', focusB.aggregate_histogram('edge_depth_class'));
      print(FOCUS_LABEL + ' 침수심 중앙값 (공식 침수위 기준, m)',
        focusB.reduceColumns(ee.Reducer.median(), ['official_depth_m']).get('median'));
    }
  }

  // ---------------------------------------------------------------------------
  // 7. 방법 ① 검증: 흔적도의 공식 침수심(F_SHIM)과 비교
  // ---------------------------------------------------------------------------
  print('===== [DEM] 7. 방법 ① 검증: 공식 침수심(' + TRACE_DEPTH_PROPERTY + ') 비교 =====');
  var validation = null;
  var traceWithDepth = hapcheonPolygonTable.filter(ee.Filter.notNull([TRACE_DEPTH_PROPERTY]));
  var traceWithDepthCount = traceWithDepth.size().getInfo();
  var traceDepthType = traceWithDepthCount > 0
    ? ee.Algorithms.ObjectType(traceWithDepth.first().get(TRACE_DEPTH_PROPERTY)).getInfo()
    : 'None';

  if (traceWithDepthCount === 0 || traceDepthType === 'String') {
    print('검증 생략',
      TRACE_DEPTH_PROPERTY + ' 값이 없거나 문자로 저장돼 있습니다. ' +
      '위 속성 이름을 보고 TRACE_DEPTH_PROPERTY를 바꾸거나, 숫자 필드로 다시 올리세요.');
  } else {
    validation = depth.reduceRegions({
      collection: keepProperties(traceWithDepth, [TRACE_DEPTH_PROPERTY]),
      reducer: ee.Reducer.median().setOutputs(['est_depth_median'])
        .combine({
          reducer2: ee.Reducer.percentile([90]).setOutputs(['est_depth_p90']),
          sharedInputs: true
        })
        .combine({
          reducer2: ee.Reducer.count().setOutputs(['est_pixels']),
          sharedInputs: true
        }),
      scale: EVAL_SCALE,
      crs: analysisProjection,
      tileScale: TILE_SCALE
    })
      .filter(ee.Filter.gt('est_pixels', 0))
      .map(function(feature) {
        var official = ee.Number(feature.get(TRACE_DEPTH_PROPERTY));
        var estimated = ee.Number(feature.get('est_depth_median'));
        return feature.set({
          official_depth_m: official,
          error_m: estimated.subtract(official),
          abs_error_m: estimated.subtract(official).abs(),
          agree_paddy_criterion: official.gte(PADDY_MIN_M).eq(estimated.gte(PADDY_MIN_M))
        });
      });

    print('공식 침수심이 있는 흔적도 polygon 수', traceWithDepthCount);
    print('검증에 쓴 polygon 수 (SAR 침수 픽셀이 있는 것)', validation.size());
    print('평균 오차: 추정 − 공식 (m, +면 과대추정)', validation.aggregate_mean('error_m'));
    print('평균 절대오차 (m)', validation.aggregate_mean('abs_error_m'));
    print('0.7 m 기준 판정 일치율 (0~1)', validation.aggregate_mean('agree_paddy_criterion'));

    print(ui.Chart.feature.byFeature({
      features: validation,
      xProperty: 'official_depth_m',
      yProperties: ['est_depth_median', 'est_depth_p90']
    })
      .setChartType('ScatterChart')
      .setOptions({
        title: 'Official depth (' + TRACE_DEPTH_PROPERTY +
          ') vs edge-method depth per flood-trace polygon',
        hAxis: {title: 'Official flood depth (m)', viewWindow: {min: 0}},
        vAxis: {title: 'Estimated flood depth (m)', viewWindow: {min: 0}},
        series: {
          0: {color: '#1565C0', labelInLegend: 'Estimated median'},
          1: {color: '#D50000', labelInLegend: 'Estimated p90'}
        },
        pointSize: 5,
        legend: {position: 'top'}
      }));
  }

  // ---------------------------------------------------------------------------
  // 8. 지도 표시 (무거운 레이어는 꺼 둠. Layers에서 켜서 확인)
  // ---------------------------------------------------------------------------
  Map.addLayer(elevation.clip(evaluationRoi),
    {min: 0, max: 400, palette: ['1A9850', 'FEE08B', 'D73027', 'FFFFFF']},
    '[DEM] Elevation (m)', false);
  Map.addLayer(slope.clip(evaluationRoi),
    {min: 0, max: 30, palette: ['FFFFFF', '8D6E63', '3E2723']},
    '[DEM] Slope (deg)', false);
  Map.addLayer(hand.clip(evaluationRoi),
    {min: 0, max: 30, palette: ['08306B', '6BAED6', 'FFFFFF']},
    '[DEM] HAND (m)', false);
  Map.addLayer(lia.clip(evaluationRoi),
    {min: 20, max: 90, palette: ['FFFFFF', '9575CD', '311B92']},
    '[DEM] Local incidence angle (deg)', false);
  Map.addLayer(plausible.eq(0).selfMask().clip(evaluationRoi),
    {palette: ['616161']},
    '[DEM] Implausible flood terrain (steep or high HAND)', false);
  Map.addLayer(depth.clip(evaluationRoi),
    {min: 0, max: 2, palette: ['E3F2FD', '42A5F5', '0D47A1']},
    '[DEM] Edge-method flood depth (m)', false);

  var depthClassColors = ee.Dictionary({
    'over_1m': '0D47A1',
    'from_07_to_1m': '42A5F5',
    'under_07m': 'B3E5FC',
    'above_water': 'BDBDBD',
    'no_value': '9E9E9E'
  });
  function styleByClass(parcels, classProperty) {
    return parcels.map(function(feature) {
      var color = ee.String(depthClassColors.get(feature.get(classProperty), '9E9E9E'));
      return feature.set('style', {color: color, fillColor: color.cat('99'), width: 2});
    }).style({styleProperty: 'style'});
  }

  Map.addLayer(styleByClass(bDem, 'edge_depth_class'), {},
    '[DEM] B parcels: edge-method depth class', bOfficial === null);
  if (bOfficial !== null) {
    Map.addLayer(styleByClass(bOfficial, 'official_depth_class'), {},
      '[DEM] B parcels: official-level depth class', true);
  }

  var demLegend = ui.Panel({style: {position: 'top-right', padding: '8px 12px'}});
  demLegend.add(ui.Label({
    value: 'B parcels: flood depth (2020 guideline, paddy)',
    style: {fontWeight: 'bold', fontSize: '13px', margin: '0 0 6px 0'}
  }));
  [['> ' + PADDY_CLEAR_M + ' m (target)', '0D47A1'],
   [PADDY_MIN_M + '–' + PADDY_CLEAR_M + ' m (local decision)', '42A5F5'],
   ['0–' + PADDY_MIN_M + ' m', 'B3E5FC'],
   ['ground above flood level', 'BDBDBD'],
   ['no value', '9E9E9E']].forEach(function(item) {
    demLegend.add(ui.Panel({
      widgets: [
        ui.Label({style: {backgroundColor: '#' + item[1], padding: '8px', margin: '0 6px 4px 0'}}),
        ui.Label({value: item[0], style: {fontSize: '12px', margin: '0 0 4px 0'}})
      ],
      layout: ui.Panel.Layout.Flow('horizontal')
    }));
  });
  Map.add(demLegend);

  // ---------------------------------------------------------------------------
  // 9. 내보내기 (Tasks 탭에서 RUN)
  // ---------------------------------------------------------------------------
  var parcelExportProperties = [
    'PNU', 'case', 'sar_overlap_ratio', 'trace_overlap_ratio',
    'depth_m_median', 'depth_m_mean', 'd_gt10_mean', 'edge_depth_class',
    'elev_m_median', 'slope_deg_median', 'hand_m_median', 'lia_deg_median', 'plausible_mean',
    'ref_wse_m', 'ref_zone', 'ref_dist_m', 'official_depth_m', 'official_depth_class'
  ];
  var bExport = (bOfficial !== null) ? bOfficial : bDem;
  var aExport = (aOfficial !== null) ? aOfficial : aDem;

  Export.table.toDrive({
    collection: zoneTable,
    description: 'Hapcheon_DEM_zone_summary_CSV',
    folder: DSG_EXPORT_FOLDER,
    fileNamePrefix: 'Hapcheon_DEM_zone_summary',
    fileFormat: 'CSV'
  });
  Export.table.toDrive({
    collection: keepProperties(bExport, parcelExportProperties),
    description: 'Hapcheon_DEM_groupB_parcels_CSV',
    folder: DSG_EXPORT_FOLDER,
    fileNamePrefix: 'Hapcheon_DEM_groupB_parcels',
    fileFormat: 'CSV'
  });
  Export.table.toDrive({
    collection: keepProperties(bExport, parcelExportProperties),
    description: 'Hapcheon_DEM_groupB_parcels_GeoJSON',
    folder: DSG_EXPORT_FOLDER,
    fileNamePrefix: 'Hapcheon_DEM_groupB_parcels',
    fileFormat: 'GeoJSON'
  });
  Export.table.toDrive({
    collection: keepProperties(aExport, parcelExportProperties),
    description: 'Hapcheon_DEM_groupA_parcels_CSV',
    folder: DSG_EXPORT_FOLDER,
    fileNamePrefix: 'Hapcheon_DEM_groupA_parcels',
    fileFormat: 'CSV'
  });
  if (validation) {
    Export.table.toDrive({
      collection: validation,
      description: 'Hapcheon_DEM_depth_validation_CSV',
      folder: DSG_EXPORT_FOLDER,
      fileNamePrefix: 'Hapcheon_DEM_depth_validation',
      fileFormat: 'CSV'
    });
  }

  print('===== [DEM] 읽는 법 =====');
  print('Q1', 'CASE3·B 놓친 부분의 plausible_share가 CASE1(TP)과 비슷하면 지형상 침수가 가능한 곳이다.');
  print('Q2', 'backslope_share·shadow_share가 높으면 산 경사면이 어둡게 찍힌 오탐 가능성이 있다.');
  print('Q3', '방법 ②에서 A 필지 대부분이 0 m보다 깊게 나오면 DEM과 공식 침수위가 맞는 것이다. ' +
    '그때 B 필지의 > 1.0 m, 0.7~1.0 m 비율이 2020년 지침 농경지 기준으로 본 근거가 된다.');
}

// -----------------------------------------------------------------------------
// [참고] 2019년 같은 궤도(61) 영상 날짜 확인 (한국시간)
// -----------------------------------------------------------------------------
var s1_2019 = ee.ImageCollection('COPERNICUS/S1_GRD')
  .filterBounds(ee.Geometry.Point(128.22, 35.59))
  .filterDate('2019-07-01', '2019-08-31')
  .filter(ee.Filter.eq('relativeOrbitNumber_start', 61))
  .filter(ee.Filter.eq('instrumentMode', 'IW'));
print(s1_2019.aggregate_array('system:time_start')
  .map(function(t){ return ee.Date(t).format('YYYY-MM-dd HH:mm', 'Asia/Seoul'); }));
