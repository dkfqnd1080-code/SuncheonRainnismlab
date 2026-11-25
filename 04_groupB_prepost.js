// =============================================================================
// 합천 2020 홍수: Sentinel-1 SAR · 침수흔적도 · 신고피해 공간적 일치성 분석 (Google Earth Engine)
// 파트 4/5 — 흔적도 밖 신고+SAR(B 그룹) 분석 · 홍수 전후 비교
// -----------------------------------------------------------------------------
// B 그룹 "놓친 부분" 폴리곤과 A·B 토지피복 비교, 홍수 전(7/28 KST) 영상과 비교한 new water 판정
// 선행 파일: 01, 03 (03의 runDamageSarTraceAnalysis()에서 이 파일의 함수가 호출된다)
//
// 실행 방법: GEE Code Editor에서 01 → 05 파일을 순서대로 하나의 스크립트에 이어 붙여 실행한다.
//           (GEE 스크립트는 파일끼리 변수를 공유하지 않으므로 파일 하나만 따로 실행하면 오류가 난다.)
// =============================================================================

// =============================================================================
// [추가] B 그룹 '놓친 부분' 폴리곤 + A·B 토지피복 비교
// -----------------------------------------------------------------------------
// 이 함수는 runDamageSarTraceAnalysis()의 맨 끝에서 호출된다(이미 넣어 둠).
// 신고피해 asset이 없어서 D/S/G 분석이 실행되지 않으면 이 함수도 실행되지 않는다.
//
// 상수를 전부 함수 안에 둔 이유:
// function 선언은 스크립트 시작 때 미리 등록되지만, var 값은 그 줄에 도달해야 채워진다.
// 이 블록은 파일 맨 끝에 있고 함수 호출은 그보다 먼저 일어나므로,
// 함수 밖에 var를 두면 호출 시점에는 undefined가 된다.
// =============================================================================

// -----------------------------------------------------------------------------
// 0. 홍수 영상 촬영 시각을 한국 시간(KST)으로 확인
// -----------------------------------------------------------------------------
// 침수흔적도 지구별 침수 시작 시각은 대부분 2020-08-08 13~17시(매호들 07시)다.
// acquisition_kst가 이보다 이르면 해당 지구는 침수 전 상태가 찍힌 것이다.
print('===== 홍수 영상 촬영 시각 (UTC / KST) =====');
print('Flood acquisition time', floodAcquisitionTable.map(function(feature) {
  var date = ee.Date(feature.get('system:time_start'));
  return feature.set('acquisition_kst', date.format('YYYY-MM-dd HH:mm:ss', 'Asia/Seoul'));
}));


function runGroupBLandcoverAnalysis(parcelCases, sImage, gImage) {
  // ---------------------------------------------------------------------------
  // 설정
  // ---------------------------------------------------------------------------
  var CODE_A = 7;                 // D1 S1 G1 (신고 + SAR + 흔적도)
  var CODE_B = 6;                 // D1 S1 G0 (신고 + SAR, 흔적도 밖)
  var MIN_POLYGON_PIXELS = 1;     // 놓친 부분 폴리곤의 최소 픽셀 수 (잡음 제거: 2~3으로 올려 볼 것)
  var CHART_CLASSES = [10, 20, 30, 40, 50, 60, 80, 90];  // 차트에 표시할 WorldCover 클래스

  // ---------------------------------------------------------------------------
  // 1. A·B 그룹 필지
  // ---------------------------------------------------------------------------
  // case 값은 D/S/G 분석 8단계에서 overlapThreshold 기준으로 이미 정해졌다.
  var groupA = parcelCases.filter(ee.Filter.eq('case', CODE_A));
  var groupB = parcelCases.filter(ee.Filter.eq('case', CODE_B));

  print('===== [B분석] 1. 그룹 필지 수 (overlap ' + overlapThreshold + ') =====');
  print('A 필지 수', groupA.size());
  print('B 필지 수', groupB.size());

  // ---------------------------------------------------------------------------
  // 2. 필지를 D/S/G와 같은 10 m 격자로 rasterize (pixel-center 기준)
  // ---------------------------------------------------------------------------
  var base = ee.Image.constant(0)
    .toByte()
    .setDefaultProjection(analysisProjection);

  function parcelMask(parcels) {
    return base
      .paint({featureCollection: parcels, color: 1})
      .updateMask(validEvaluationMask)
      .clip(evaluationRoi)
      .eq(1);
  }

  var aParcelMask = parcelMask(groupA);
  var bParcelMask = parcelMask(groupB);

  // ---------------------------------------------------------------------------
  // 3. 놓친 부분 = B 필지 안에서 SAR = 1 이고 흔적도 = 0 인 픽셀 → 폴리곤
  // ---------------------------------------------------------------------------
  // 인접한 B 필지의 놓친 부분은 하나의 폴리곤으로 이어질 수 있다.
  var missedImage = sImage.eq(1)
    .and(gImage.eq(0))
    .and(bParcelMask)
    .rename('missed')
    .selfMask();

  var missedPolygons = missedImage.reduceToVectors({
    geometry: evaluationRoi,
    crs: analysisProjection,
    scale: EVAL_SCALE,
    geometryType: 'polygon',
    eightConnected: true,
    labelProperty: 'missed',
    reducer: ee.Reducer.countEvery(),   // 폴리곤마다 픽셀 수를 'count'로 저장
    maxPixels: MAX_PIXELS,
    tileScale: TILE_SCALE
  })
    .filter(ee.Filter.gte('count', MIN_POLYGON_PIXELS))
    .map(function(feature) {
      return feature.set('area_m2', feature.geometry().area(1));
    });

  print('===== [B분석] 3. 놓친 부분 폴리곤 =====');
  print('폴리곤 수', missedPolygons.size());
  print('총 면적 (m2)', missedPolygons.aggregate_sum('area_m2'));
  print('총 픽셀 수', missedPolygons.aggregate_sum('count'));

  // ---------------------------------------------------------------------------
  // 4. B 필지별 지표: 놓친 면적·비율, 흔적도까지 거리, 주 토지피복
  // ---------------------------------------------------------------------------
  // 놓친 면적은 6단계(sar_area_m2)와 같은 가중합 방식으로 계산해 비율을 비교할 수 있게 한다.
  var missedAreaImage = sImage.eq(1)
    .and(gImage.eq(0))
    .multiply(ee.Image.pixelArea())
    .rename('missed_area_m2');

  var traceGeometry = hapcheonPolygonTable.geometry();

  // 필지 안에서 가장 많은 WorldCover 클래스(최빈값)를 주 토지피복으로 붙인다.
  function addDominantLandcover(parcels) {
    return hapcheonWorldCover.reduceRegions({
      collection: parcels,
      reducer: ee.Reducer.mode().setOutputs(['lc_mode']),
      scale: EVAL_SCALE,
      crs: analysisProjection,
      tileScale: TILE_SCALE
    }).map(function(feature) {
      var mode = feature.get('lc_mode');
      return feature.set('lc_mode_name', ee.Algorithms.If(
        ee.Algorithms.IsEqual(mode, null),
        'No WorldCover data',
        getHapcheonWorldCoverName(mode)
      ));
    });
  }

  var bWithMissed = missedAreaImage.reduceRegions({
    collection: groupB,
    reducer: ee.Reducer.sum().setOutputs(['missed_area_m2']),
    scale: EVAL_SCALE,
    crs: analysisProjection,
    tileScale: TILE_SCALE
  });

  var groupBResult = addDominantLandcover(bWithMissed).map(function(feature) {
    var missedArea = dsgNumberOrZero(feature, 'missed_area_m2');
    return feature.set({
      missed_area_m2: missedArea,
      missed_ratio: safeRatio(missedArea, feature.get('valid_area_m2')),
      // 0 m: 흔적도와 맞닿거나 일부 겹침(경계 오차 가능성) / 클수록 흔적도와 떨어진 곳
      // 계산이 오래 걸려 Computation timed out이 나면 이 줄과 아래 거리 히스토그램을 주석 처리한다.
      dist_to_trace_m: feature.geometry().distance(traceGeometry, 1)
    });
  });

  var groupAResult = addDominantLandcover(groupA);

  print('===== [B분석] 4. 필지 단위 결과 =====');
  print('B 필지 결과 첫 행 (속성 확인)', groupBResult.first());
  print('B 필지 놓친 면적 합계 (m2)', groupBResult.aggregate_sum('missed_area_m2'));
  print('B 필지 → 흔적도 거리 분포 (m)',
    ui.Chart.feature.histogram(groupBResult, 'dist_to_trace_m', 30)
      .setOptions({
        title: 'Distance from group B parcels to the flood trace map',
        hAxis: {title: 'Distance (m)'},
        vAxis: {title: 'Number of parcels'},
        legend: {position: 'none'}
      }));

  // ---------------------------------------------------------------------------
  // 5. 토지피복 (필지 수 기준): 필지마다 주 토지피복 하나씩
  // ---------------------------------------------------------------------------
  print('===== [B분석] 5. 주 토지피복별 필지 수 =====');
  print('A 필지', groupAResult.aggregate_histogram('lc_mode_name'));
  print('B 필지', groupBResult.aggregate_histogram('lc_mode_name'));

  // ---------------------------------------------------------------------------
  // 6. 토지피복 (픽셀 면적 기준): A 필지 / B 필지 / B 놓친 부분 / ROI 전체
  // ---------------------------------------------------------------------------
  // ROI 전체는 "원래 그 지역에 많은 토지피복"을 보여 주는 비교 기준이다.
  // [수정] 이전 버전 차트에서 A·B 그룹의 비율 합이 1이 안 되는 문제가 있었다.
  //   - 클래스별 픽셀 수를 frequencyHistogram 대신 grouped sum(원본 3-case 분석과 같은 방식)으로 센다.
  //   - 클래스 표는 서버 쪽 map 대신 JavaScript 반복문으로 만든다.
  //   - 아래 '검증' 출력에서 그룹별 share 합이 1인지 확인한다.
  var LC_VALUES_JS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100];
  var LC_NAMES_JS = [
    'Tree cover', 'Shrubland', 'Grassland', 'Cropland', 'Built-up',
    'Bare / sparse vegetation', 'Snow and ice', 'Permanent water bodies',
    'Herbaceous wetland', 'Mangroves', 'Moss and lichen'
  ];

  function landcoverComposition(maskImage, groupLabel, groupOrder) {
    var countImage = ee.Image.constant(1)
      .setDefaultProjection(analysisProjection)
      .rename('pixels')
      .updateMask(maskImage)
      .updateMask(hapcheonWorldCover.mask())
      .addBands(hapcheonWorldCover.updateMask(maskImage));

    var stats = countImage.reduceRegion({
      reducer: ee.Reducer.sum()
        .unweighted()
        .group({groupField: 1, groupName: 'landcover_value'}),
      geometry: evaluationRoi,
      scale: EVAL_SCALE,
      crs: analysisProjection,
      maxPixels: MAX_PIXELS,
      tileScale: TILE_SCALE
    });

    var groups = ee.List(ee.Dictionary(stats).get('groups', ee.List([])));
    var lookup = ee.Dictionary.fromLists(
      groups.map(function(group) {
        return ee.Number(ee.Dictionary(group).get('landcover_value')).format('%.0f');
      }),
      groups.map(function(group) {
        return ee.Dictionary(group).get('sum');
      })
    );
    var total = ee.Number(ee.Algorithms.If(
      groups.size().gt(0),
      ee.List(lookup.values()).reduce(ee.Reducer.sum()),
      0
    ));

    return ee.FeatureCollection(LC_VALUES_JS.map(function(value, index) {
      var pixels = ee.Number(lookup.get(String(value), 0));
      return ee.Feature(null, {
        group_order: groupOrder,
        group_label: groupLabel,
        landcover_value: value,
        landcover_name: LC_NAMES_JS[index],
        pixels: pixels,
        group_total_pixels: total,
        share: safeRatio(pixels, total)
      });
    }));
  }

  var compositionTable = landcoverComposition(aParcelMask, 'A parcels', 1)
    .merge(landcoverComposition(bParcelMask, 'B parcels', 2))
    .merge(landcoverComposition(missedImage.mask(), 'B missed area', 3))
    .merge(landcoverComposition(ee.Image(1), 'Whole ROI', 4))
    .sort('group_order');

  // 검증: 각 그룹의 share 합은 1이어야 한다 (1이 아니면 차트를 쓰지 말 것).
  var compositionShareSums = {};
  ['A parcels', 'B parcels', 'B missed area', 'Whole ROI'].forEach(function(label) {
    compositionShareSums[label] = compositionTable
      .filter(ee.Filter.eq('group_label', label))
      .aggregate_sum('share');
  });

  print('===== [B분석] 6. 토지피복 구성 (픽셀 기준) =====');
  print('A / B / B 놓친 부분 / ROI 전체 x WorldCover', compositionTable);
  print('검증: 그룹별 share 합 (각각 1이어야 함)', ee.Dictionary(compositionShareSums));

  print(ui.Chart.feature.groups(
    compositionTable.filter(ee.Filter.inList('landcover_value', CHART_CLASSES)),
    'landcover_name',
    'share',
    'group_label'
  )
    .setChartType('ColumnChart')
    .setOptions({
      title: 'Land cover composition: A parcels vs B parcels vs B missed area vs whole ROI',
      hAxis: {title: 'ESA WorldCover 2020 class', slantedText: true, slantedTextAngle: 45},
      vAxis: {title: 'Share within group (0-1)', viewWindow: {min: 0}},
      colors: ['#6A1B9A', '#FF6D00', '#D50000', '#9E9E9E'],
      legend: {position: 'top'},
      bar: {groupWidth: '75%'}
    }));

  // ---------------------------------------------------------------------------
  // 7. 지도 표시
  // ---------------------------------------------------------------------------
  Map.addLayer(
    groupA.style({color: '6A1B9A', fillColor: '00000000', width: 1}),
    {}, '[B분석] A parcels (outline)', false);
  Map.addLayer(
    groupB.style({color: 'FF6D00', fillColor: '00000000', width: 2}),
    {}, '[B분석] B parcels (outline)', true);
  Map.addLayer(
    missedPolygons.style({color: 'D50000', fillColor: 'D5000088', width: 1}),
    {}, '[B분석] B missed area (SAR=1, trace=0)', true);

  // ---------------------------------------------------------------------------
  // 8. 내보내기 (Tasks 탭에서 RUN)
  // ---------------------------------------------------------------------------
  var bExportProperties = [
    'PNU', 'case_key', 'sar_overlap_ratio', 'trace_overlap_ratio',
    'missed_area_m2', 'missed_ratio', 'dist_to_trace_m',
    'lc_mode', 'lc_mode_name', 'damage_value', 'valid_area_m2'
  ];

  Export.table.toDrive({
    collection: groupBResult.select(bExportProperties),
    description: 'Hapcheon_groupB_parcels_CSV',
    folder: DSG_EXPORT_FOLDER,
    fileNamePrefix: 'Hapcheon_groupB_parcels',
    fileFormat: 'CSV'
  });
  Export.table.toDrive({
    collection: groupBResult.select(bExportProperties),
    description: 'Hapcheon_groupB_parcels_GeoJSON',
    folder: DSG_EXPORT_FOLDER,
    fileNamePrefix: 'Hapcheon_groupB_parcels',
    fileFormat: 'GeoJSON'
  });
  Export.table.toDrive({
    collection: missedPolygons,
    description: 'Hapcheon_groupB_missed_area_GeoJSON',
    folder: DSG_EXPORT_FOLDER,
    fileNamePrefix: 'Hapcheon_groupB_missed_area',
    fileFormat: 'GeoJSON'
  });
  Export.table.toDrive({
    collection: compositionTable,
    description: 'Hapcheon_groupAB_landcover_CSV',
    folder: DSG_EXPORT_FOLDER,
    fileNamePrefix: 'Hapcheon_groupAB_landcover',
    fileFormat: 'CSV'
  });
}

// =============================================================================
// [추가 2] 홍수 전 영상(7월 27일)과 비교: SAR가 잡은 물이 홍수 때 새로 생긴 것인가
// -----------------------------------------------------------------------------
// runDamageSarTraceAnalysis()의 맨 끝에서 runGroupBLandcoverAnalysis() 다음에 호출된다.
// 원본 baseline·D/S/G 결과는 바꾸지 않고, 비교 결과만 새로 출력한다.
//
// 처리 조건은 홍수 영상과 똑같이 맞춘다:
//   같은 궤도(61번, 하강) · VV · 5x5 Lee 필터 · 10 m analysisProjection 격자
//   홍수 영상에서 구한 Otsu 임계값을 두 영상에 똑같이 적용
//
// 픽셀 판정 (홍수 영상에서 침수 후보(SAR=1)인 픽셀만 대상)
//   1 new water       : 홍수 전에는 임계값보다 밝았고, CHANGE_DB 이상 어두워짐 → 홍수로 새로 생긴 물
//   2 persistent dark : 홍수 전에도 임계값 이하로 어두웠음 → 평소 물·논물·그림자 등
//   3 weak change     : 홍수 전에는 밝았지만 어두워진 정도가 CHANGE_DB보다 작음 → 판단 보류
// =============================================================================

// 홍수 전 날짜를 고를 수 있도록 같은 궤도의 2020년 6~8월 영상 목록을 먼저 보여 준다.
// (acquisition_utc 날짜를 아래 PRE_START에 넣는다. GEE 날짜는 UTC 기준이다.)
print('===== [전후비교] 같은 궤도 영상 목록 (2020-06-01 ~ 2020-08-31) =====');
print('Relative orbit ' + RELATIVE_ORBIT + ' scenes',
  makeHapcheonAcquisitionTable(
    hapcheonS1.filterDate('2020-06-01', '2020-09-01').sort('system:time_start'),
    'Candidate'
  ).map(function(feature) {
    var date = ee.Date(feature.get('system:time_start'));
    return feature.set('acquisition_kst', date.format('YYYY-MM-dd HH:mm:ss', 'Asia/Seoul'));
  }));


function runPrePostComparison(parcelCases, sImage, gImage) {
  // ---------------------------------------------------------------------------
  // 설정
  // ---------------------------------------------------------------------------
  var PRE_START = '2020-07-27';   // 홍수 전 영상 날짜 (UTC)
  var PRE_END = '2020-07-28';     // 종료일은 포함되지 않는다
  var CHANGE_DB = 3;              // 이만큼(dB) 이상 어두워져야 '새로 생긴 물'. 2·4로 바꿔 민감도 확인
  var CODE_A = 7;                 // D1 S1 G1
  var CODE_B = 6;                 // D1 S1 G0
  var CLASS_COLORS = ['1565C0', 'F9A825', '9E9E9E'];  // new / persistent / weak

  // ---------------------------------------------------------------------------
  // 1. 홍수 전 영상: 홍수 영상과 똑같은 방식으로 처리
  // ---------------------------------------------------------------------------
  var preCollection = hapcheonS1
    .filterDate(PRE_START, PRE_END)
    .sort('system:index');

  print('===== [전후비교] 1. 홍수 전 영상 =====');
  var preSceneCount = preCollection.size().getInfo();
  print('홍수 전 scene 수 (1 이상이어야 함)', preSceneCount);
  if (preSceneCount === 0) {
    print('WARNING: ' + PRE_START + ' 에 궤도 ' + RELATIVE_ORBIT +
      ' 영상이 없습니다. 위 영상 목록에서 날짜를 골라 PRE_START·PRE_END를 바꾸세요.');
    return;
  }
  print('홍수 전 촬영 시각', makeHapcheonAcquisitionTable(preCollection, 'Pre')
    .map(function(feature) {
      var date = ee.Date(feature.get('system:time_start'));
      return feature.set('acquisition_kst', date.format('YYYY-MM-dd HH:mm:ss', 'Asia/Seoul'));
    }));

  var preVV = preCollection
    .mosaic()
    .setDefaultProjection(analysisProjection)
    .select('VV')
    .rename('Pre_VV_dB');
  var preVVLeeLinear = leeFilter5x5Linear(dbToLinearPower(preVV), evaluationRoi);
  var preVVLeeDb = linearPowerToDb(preVVLeeLinear, 'Pre_VV_Lee_dB');
  print('홍수 전 Lee noise CV2', preVVLeeLinear.get('lee_noise_cv2'));
  print('두 영상에 똑같이 적용한 Otsu 임계값 (dB, 홍수 영상 기준)', otsuThreshold);

  // ---------------------------------------------------------------------------
  // 2. 변화량과 픽셀 판정
  // ---------------------------------------------------------------------------
  var prePostValid = validEvaluationMask.and(preVVLeeDb.mask().gt(0));

  var pre = preVVLeeDb.rename('pre_vv_db');
  var post = floodVVLeeDb.rename('post_vv_db');
  var delta = post.subtract(pre).rename('delta_vv_db');   // 음수 = 홍수 때 어두워짐

  var postDark = post.lte(otsuThreshold);   // = SAR 침수 후보 (floodCandidate와 같은 조건)
  var preDark = pre.lte(otsuThreshold);
  var newWater = postDark.and(preDark.not()).and(delta.lte(-CHANGE_DB));
  var persistentDark = postDark.and(preDark);
  var weakChange = postDark.and(preDark.not()).and(delta.gt(-CHANGE_DB));

  // 0 = 침수 후보 아님, 1 = new water, 2 = persistent dark, 3 = weak change
  var changeClass = ee.Image.constant(0)
    .setDefaultProjection(analysisProjection)
    .toByte()
    .where(newWater, 1)
    .where(persistentDark, 2)
    .where(weakChange, 3)
    .updateMask(prePostValid)
    .clip(evaluationRoi)
    .rename('change_class');

  // ---------------------------------------------------------------------------
  // 3. A·B 필지별 홍수 전/후 VV와 판정
  // ---------------------------------------------------------------------------
  var groupA = parcelCases.filter(ee.Filter.eq('case', CODE_A));
  var groupB = parcelCases.filter(ee.Filter.eq('case', CODE_B));

  var vvStatsImage = ee.Image.cat([pre, post, delta]).updateMask(prePostValid);
  var areaStatsImage = ee.Image.cat([
    ee.Image.pixelArea().rename('pp_valid_area_m2'),
    newWater.multiply(ee.Image.pixelArea()).rename('new_water_area_m2'),
    persistentDark.multiply(ee.Image.pixelArea()).rename('persistent_area_m2'),
    weakChange.multiply(ee.Image.pixelArea()).rename('weak_area_m2')
  ]).updateMask(prePostValid);

  // 판정 기준: 필지 면적의 overlapThreshold(기본 10%) 이상이면 그 유형으로 본다.
  // new water가 기준 이상이면 persistent dark가 함께 있어도 new water로 판정한다.
  function addPrePostMetrics(parcels) {
    var withVV = vvStatsImage.reduceRegions({
      collection: parcels,
      reducer: ee.Reducer.mean().forEachBand(vvStatsImage),
      scale: EVAL_SCALE,
      crs: analysisProjection,
      tileScale: TILE_SCALE
    });
    var withArea = areaStatsImage.reduceRegions({
      collection: withVV,
      reducer: ee.Reducer.sum().forEachBand(areaStatsImage),
      scale: EVAL_SCALE,
      crs: analysisProjection,
      tileScale: TILE_SCALE
    });
    return withArea.map(function(feature) {
      var validArea = dsgNumberOrZero(feature, 'pp_valid_area_m2');
      var newRatio = safeRatio(dsgNumberOrZero(feature, 'new_water_area_m2'), validArea);
      var persistentRatio = safeRatio(dsgNumberOrZero(feature, 'persistent_area_m2'), validArea);
      var weakRatio = safeRatio(dsgNumberOrZero(feature, 'weak_area_m2'), validArea);
      var prePostClass = ee.Algorithms.If(
        validArea.gt(0),
        ee.Algorithms.If(
          ee.Number(newRatio).gte(overlapThreshold),
          'new_water',
          ee.Algorithms.If(
            ee.Number(persistentRatio).gte(overlapThreshold),
            'persistent_dark',
            'weak_or_no_change'
          )
        ),
        'no_pre_data'
      );
      return feature.set({
        new_water_ratio: newRatio,
        persistent_ratio: persistentRatio,
        weak_ratio: weakRatio,
        prepost_class: prePostClass
      });
    });
  }

  var aPrePost = addPrePostMetrics(groupA);
  var bPrePost = addPrePostMetrics(groupB);

  function medianOf(collection, property) {
    return collection
      .filter(ee.Filter.notNull([property]))
      .reduceColumns(ee.Reducer.median(), [property])
      .get('median');
  }

  var prePostSummary = ee.FeatureCollection([
    ee.Feature(null, {
      group: 'A parcels (Report + SAR + Trace)',
      n_parcels: aPrePost.size(),
      pre_vv_median_db: medianOf(aPrePost, 'pre_vv_db'),
      post_vv_median_db: medianOf(aPrePost, 'post_vv_db'),
      delta_vv_median_db: medianOf(aPrePost, 'delta_vv_db')
    }),
    ee.Feature(null, {
      group: 'B parcels (Report + SAR)',
      n_parcels: bPrePost.size(),
      pre_vv_median_db: medianOf(bPrePost, 'pre_vv_db'),
      post_vv_median_db: medianOf(bPrePost, 'post_vv_db'),
      delta_vv_median_db: medianOf(bPrePost, 'delta_vv_db')
    })
  ]);

  print('===== [전후비교] 3. 필지 단위 결과 (판정 기준: 면적의 ' +
    Math.round(overlapThreshold * 100) + '% 이상, 변화 ' + CHANGE_DB + ' dB) =====');
  print('A·B 필지 홍수 전/후 VV 중앙값과 변화량 (dB)', prePostSummary);
  print('A 필지 판정별 수', aPrePost.aggregate_histogram('prepost_class'));
  print('B 필지 판정별 수', bPrePost.aggregate_histogram('prepost_class'));
  print('B 필지 결과 첫 행 (속성 확인)', bPrePost.first());

  print(ui.Chart.feature.histogram(aPrePost, 'delta_vv_db', 30).setOptions({
    title: 'A parcels: VV change (flood - pre-flood, dB)',
    hAxis: {title: 'VV change (dB), negative = darker during flood'},
    vAxis: {title: 'Number of parcels'},
    colors: ['#6A1B9A'],
    legend: {position: 'none'}
  }));
  print(ui.Chart.feature.histogram(bPrePost, 'delta_vv_db', 30).setOptions({
    title: 'B parcels: VV change (flood - pre-flood, dB)',
    hAxis: {title: 'VV change (dB), negative = darker during flood'},
    vAxis: {title: 'Number of parcels'},
    colors: ['#FF6D00'],
    legend: {position: 'none'}
  }));

  // ---------------------------------------------------------------------------
  // 4. 픽셀 단위 구성: 침수 후보 픽셀 중 new / persistent / weak 비율
  // ---------------------------------------------------------------------------
  // B 놓친 부분이 A(확인된 침수)와 비슷한 비율로 new water라면 홍수로 볼 근거가 강해진다.
  var base = ee.Image.constant(0)
    .toByte()
    .setDefaultProjection(analysisProjection);

  function parcelMask(parcels) {
    return base
      .paint({featureCollection: parcels, color: 1})
      .updateMask(validEvaluationMask)
      .clip(evaluationRoi)
      .eq(1);
  }

  var aMask = parcelMask(groupA);
  var bMask = parcelMask(groupB);

  var zones = [
    {label: 'A parcels: SAR & trace', mask: sImage.eq(1).and(gImage.eq(1)).and(aMask)},
    {label: 'B missed area: SAR, outside trace', mask: sImage.eq(1).and(gImage.eq(0)).and(bMask)},
    {label: 'All TP (SAR & trace)', mask: sImage.eq(1).and(gImage.eq(1))},
    {label: 'All Outside-GT (SAR only)', mask: sImage.eq(1).and(gImage.eq(0))}
  ];
  var CLASS_CODES = [1, 2, 3];
  var CLASS_NAMES = ['1 new water', '2 persistent dark', '3 weak change'];

  var zoneRows = [];
  zones.forEach(function(zone, zoneIndex) {
    var stats = ee.Image.constant(1)
      .setDefaultProjection(analysisProjection)
      .rename('pixels')
      .updateMask(zone.mask)
      .updateMask(changeClass.gt(0))
      .addBands(changeClass.updateMask(zone.mask))
      .reduceRegion({
        reducer: ee.Reducer.sum()
          .unweighted()
          .group({groupField: 1, groupName: 'change_class'}),
        geometry: evaluationRoi,
        scale: EVAL_SCALE,
        crs: analysisProjection,
        maxPixels: MAX_PIXELS,
        tileScale: TILE_SCALE
      });

    var groups = ee.List(ee.Dictionary(stats).get('groups', ee.List([])));
    var lookup = ee.Dictionary.fromLists(
      groups.map(function(group) {
        return ee.Number(ee.Dictionary(group).get('change_class')).format('%.0f');
      }),
      groups.map(function(group) {
        return ee.Dictionary(group).get('sum');
      })
    );
    var total = ee.Number(ee.Algorithms.If(
      groups.size().gt(0),
      ee.List(lookup.values()).reduce(ee.Reducer.sum()),
      0
    ));

    CLASS_CODES.forEach(function(code, classIndex) {
      var pixels = ee.Number(lookup.get(String(code), 0));
      zoneRows.push(ee.Feature(null, {
        zone_order: zoneIndex + 1,
        zone: zone.label,
        change_class: code,
        change_name: CLASS_NAMES[classIndex],
        pixels: pixels,
        zone_total_pixels: total,
        share: safeRatio(pixels, total)
      }));
    });
  });

  var zoneTable = ee.FeatureCollection(zoneRows);

  print('===== [전후비교] 4. 침수 후보 픽셀의 변화 유형 구성 =====');
  print('영역별 new / persistent / weak 픽셀 수와 비율', zoneTable);
  print(ui.Chart.feature.groups(zoneTable, 'zone', 'share', 'change_name')
    .setChartType('ColumnChart')
    .setOptions({
      title: 'Pre/post change type of SAR flood-candidate pixels (change threshold ' + CHANGE_DB + ' dB)',
      isStacked: true,
      colors: CLASS_COLORS.map(function(color) { return '#' + color; }),
      hAxis: {title: 'Zone', slantedText: true, slantedTextAngle: 20},
      vAxis: {title: 'Share of SAR flood-candidate pixels', viewWindow: {min: 0, max: 1}},
      legend: {position: 'top'},
      bar: {groupWidth: '60%'}
    }));

  // ---------------------------------------------------------------------------
  // 5. 지도 표시
  // ---------------------------------------------------------------------------
  Map.addLayer(preVV.clip(evaluationRoi), vvVis, '[전후비교] Pre-flood VV', false);
  Map.addLayer(preVVLeeDb.clip(evaluationRoi), vvVis, '[전후비교] Pre-flood VV Lee filtered', false);
  Map.addLayer(
    delta.updateMask(prePostValid).clip(evaluationRoi),
    {min: -10, max: 10, palette: ['0D47A1', 'FFFFFF', 'B71C1C']},
    '[전후비교] VV change (blue = darker during flood)',
    false
  );
  Map.addLayer(
    changeClass.updateMask(changeClass.gt(0)),
    {min: 1, max: 3, palette: CLASS_COLORS},
    '[전후비교] SAR candidate pixels: new / persistent / weak',
    true
  );

  var classColorLookup = ee.Dictionary({
    new_water: CLASS_COLORS[0],
    persistent_dark: CLASS_COLORS[1],
    weak_or_no_change: CLASS_COLORS[2],
    no_pre_data: '000000'
  });
  var bStyled = bPrePost.map(function(feature) {
    var color = ee.String(classColorLookup.get(feature.get('prepost_class'), '000000'));
    return feature.set('style', {color: color, fillColor: color.cat('66'), width: 2});
  });
  Map.addLayer(
    bStyled.style({styleProperty: 'style'}),
    {},
    '[전후비교] B parcels by pre/post class',
    true
  );

  var prePostLegend = ui.Panel({style: {position: 'bottom-right', padding: '8px 12px'}});
  prePostLegend.add(ui.Label({
    value: 'Pre/post change (' + PRE_START + ' vs flood)',
    style: {fontWeight: 'bold', fontSize: '13px', margin: '0 0 6px 0'}
  }));
  [['1 new water (flood)', CLASS_COLORS[0]],
   ['2 persistent dark (dark before flood too)', CLASS_COLORS[1]],
   ['3 weak change', CLASS_COLORS[2]]].forEach(function(item) {
    prePostLegend.add(ui.Panel({
      widgets: [
        ui.Label({style: {backgroundColor: '#' + item[1], padding: '8px', margin: '0 6px 4px 0'}}),
        ui.Label({value: item[0], style: {fontSize: '12px', margin: '0 0 4px 0'}})
      ],
      layout: ui.Panel.Layout.Flow('horizontal')
    }));
  });
  Map.add(prePostLegend);

  // ---------------------------------------------------------------------------
  // 6. 내보내기 (Tasks 탭에서 RUN)
  // ---------------------------------------------------------------------------
  var prePostProperties = [
    'PNU', 'case_key', 'sar_overlap_ratio', 'trace_overlap_ratio',
    'pre_vv_db', 'post_vv_db', 'delta_vv_db',
    'new_water_ratio', 'persistent_ratio', 'weak_ratio', 'prepost_class',
    'damage_value'
  ];

  Export.table.toDrive({
    collection: bPrePost.select(prePostProperties),
    description: 'Hapcheon_groupB_prepost_CSV',
    folder: DSG_EXPORT_FOLDER,
    fileNamePrefix: 'Hapcheon_groupB_prepost',
    fileFormat: 'CSV'
  });
  Export.table.toDrive({
    collection: aPrePost.select(prePostProperties),
    description: 'Hapcheon_groupA_prepost_CSV',
    folder: DSG_EXPORT_FOLDER,
    fileNamePrefix: 'Hapcheon_groupA_prepost',
    fileFormat: 'CSV'
  });
  Export.table.toDrive({
    collection: zoneTable,
    description: 'Hapcheon_prepost_pixel_composition_CSV',
    folder: DSG_EXPORT_FOLDER,
    fileNamePrefix: 'Hapcheon_prepost_pixel_composition',
    fileFormat: 'CSV'
  });
}
