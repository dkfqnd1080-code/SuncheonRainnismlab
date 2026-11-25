// =============================================================================
// 합천 2020 홍수: Sentinel-1 SAR · 침수흔적도 · 신고피해 공간적 일치성 분석 (Google Earth Engine)
// 파트 3/5 — 신고피해(D) · SAR(S) · 침수흔적도(G) 중첩 분석
// -----------------------------------------------------------------------------
// 신고피해 필지 asset을 불러와 D/S/G 조합(Case)별 필지 수·면적·토지피복을 계산하고 실행 블록을 둔다
// 선행 파일: 01, 02 / 04의 함수(runGroupBLandcoverAnalysis, runPrePostComparison)를 호출한다
// (function 선언은 스크립트 시작 때 등록되므로 04가 뒤에 붙어 있어도 호출된다)
//
// 실행 방법: GEE Code Editor에서 01 → 05 파일을 순서대로 하나의 스크립트에 이어 붙여 실행한다.
//           (GEE 스크립트는 파일끼리 변수를 공유하지 않으므로 파일 하나만 따로 실행하면 오류가 난다.)
// =============================================================================

// =============================================================================
// HAPCHEON D / S / G OVERLAP ANALYSIS
// D = Damage report   : 신고피해 필지 polygon (class_type == '필지 경계'만)
// S = SAR             : Sentinel-1 Otsu 침수 후보영역 (baseline floodCandidate)
// G = Ground (official): 공식 침수흔적도 (baseline hapcheonPolygonTable)
// -----------------------------------------------------------------------------
// 이 블록은 위 Otsu baseline 코드 뒤에 이어서 실행된다.
// baseline의 floodCandidate, hapcheonPolygonTable, evaluationRoi,
// analysisProjection, validEvaluationMask, EVAL_SCALE, MAX_PIXELS,
// TILE_SCALE, safeRatio()를 그대로 쓰며 baseline 결과는 바꾸지 않는다.
//
// 신고피해 필지 asset이 GEE에 아직 없으면(업로드 전·업로드 중)
// 1~13단계를 실행하지 않고, 콘솔에 해결 방법과 프로젝트의 table 목록만 보여 준다.
// =============================================================================

// -----------------------------------------------------------------------------
// 0. 사용자 설정 (여기만 바꾸면 된다)
// -----------------------------------------------------------------------------
// 신고피해 필지 polygon asset ID: 본인 asset 경로로 바꿔야 한다.
var DAMAGE_ASSET_ID = 'projects/project-fb657ed8-3710-4dc0-be9/assets/Hapcheon_damage_parcels';

// 이 값과 정확히 같은 class_type만 D로 쓴다.
var PARCEL_CLASS_VALUE = '필지 경계';

// 필지 면적 중 이 비율 이상이 겹쳐야 S=1(또는 G=1)로 판정한다.
// 0이면 "조금이라도 겹치면(> 0)" 일치로 본다.
var overlapThreshold = 0.1;

// 민감도 분석용 threshold: > 0%, >= 10%, >= 30%, >= 50%
var sensitivityThresholds = [0, 0.1, 0.3, 0.5];

// 원본 집계표에서 농약대·대파대 신고는 피해금액 칸이 0으로 적혀 있다.
// 이는 "피해 0원"이 아니라 "피해금액 미산정"이므로,
// true면 0도 missing(null)으로 처리해 평균·중앙값이 0으로 끌려가지 않게 한다.
var ZERO_DAMAGE_AS_MISSING = true;

// Google Drive export 폴더 이름
var DSG_EXPORT_FOLDER = 'GEE_Hapcheon_DSG';

// 차트 ④의 피해금액 단위 표기. 원본 집계표 단위가 천원이 아니면 여기만 바꾼다.
var DSG_DAMAGE_UNIT_LABEL = 'thousand KRW';

// 엑셀(2020호우_사유재산피해_분류색표시) 기준 참고값. 콘솔 결과와 비교용.
// 필지 경계 1,746건 / 고유 PNU 1,688개 / 피해금액 > 0 신고 68건
// 피해금액이 있는 PNU 59개 / 합계 828,950 / 중앙값 6,299 (원본 단위, 천원으로 보임)
// (asset을 만들 때 일부 필지가 빠졌거나 ROI 밖이면 값이 조금 다를 수 있다.)

// 연구지역·SAR·흔적도는 baseline 객체를 그대로 연결한다.
// 세 레이어 모두 Sentinel-1 VV 격자(analysisProjection), 10 m, 같은 ROI,
// 같은 valid mask를 쓰므로 projection·extent·scale이 일치한다.
var roi = evaluationRoi;
var sarFlood = floodCandidate;          // 0/1 binary (평가용, selfMask 안 함)
var floodTrace = hapcheonPolygonTable;  // vector → 3단계에서 rasterize
var dsgProjection = analysisProjection;
var DSG_SCALE = EVAL_SCALE;             // 10 m

// case code = D*4 + S*2 + G  (0 = D0 S0 G0 → 제외)
var DSG_CASES = [
  {code: 7, D: 1, S: 1, G: 1, group: 'A', key: 'D1S1G1', color: '6A1B9A',
   label: 'D1 S1 G1  Report + SAR + Trace map'},
  {code: 6, D: 1, S: 1, G: 0, group: 'B', key: 'D1S1G0', color: 'FF6D00',
   label: 'D1 S1 G0  Report + SAR'},
  {code: 5, D: 1, S: 0, G: 1, group: 'C', key: 'D1S0G1', color: '0091EA',
   label: 'D1 S0 G1  Report + Trace map'},
  {code: 4, D: 1, S: 0, G: 0, group: 'D', key: 'D1S0G0', color: 'FF4081',
   label: 'D1 S0 G0  Report only'},
  {code: 3, D: 0, S: 1, G: 1, group: '-', key: 'D0S1G1', color: '00C853',
   label: 'D0 S1 G1  SAR + Trace map (no report)'},
  {code: 2, D: 0, S: 1, G: 0, group: '-', key: 'D0S1G0', color: 'D50000',
   label: 'D0 S1 G0  SAR only'},
  {code: 1, D: 0, S: 0, G: 1, group: '-', key: 'D0S0G1', color: 'FFD600',
   label: 'D0 S0 G1  Trace map only'}
];
var DSG_NO_DATA_COLOR = '9E9E9E';
var DSG_PARCEL_CODES = [7, 6, 5, 4];

var dsgCodeToKey = ee.Dictionary({'7': 'D1S1G1', '6': 'D1S1G0', '5': 'D1S0G1', '4': 'D1S0G0'});
var dsgCodeToGroup = ee.Dictionary({'7': 'A', '6': 'B', '5': 'C', '4': 'D'});
var dsgCodeToColor = ee.Dictionary({
  '7': '6A1B9A', '6': 'FF6D00', '5': '0091EA', '4': 'FF4081', 'no_data': DSG_NO_DATA_COLOR
});

function dsgCaseInfo(code) {
  return DSG_CASES.filter(function(c) { return c.code === code; })[0];
}

function dsgNumberOrZero(feature, propertyName) {
  var value = ee.Feature(feature).get(propertyName);
  return ee.Number(ee.Algorithms.If(ee.Algorithms.IsEqual(value, null), 0, value));
}

// =============================================================================
// D/S/G 분석 본체 (1~13단계)
// 맨 끝의 "실행" 부분에서 신고피해 asset이 있을 때만 호출된다.
// =============================================================================
function runDamageSarTraceAnalysis() {
  // -----------------------------------------------------------------------------
  // 1. 신고피해자료에서 필지경계 polygon만 필터링
  // -----------------------------------------------------------------------------
  // 이유: 주소점·가설 위치·대표 좌표는 실제 피해 필지의 경계가 아니다.
  // 면적 기반 중첩 분석에 넣으면 위치 오차가 결과에 그대로 섞이므로,
  // 가장 먼저 걸러내고 이후 모든 D 분석은 이 damageFC만 쓴다.
  var damageAll = ee.FeatureCollection(DAMAGE_ASSET_ID);
  var damageFC = damageAll;
  damageFC = damageFC.filter(ee.Filter.eq('class_type', PARCEL_CLASS_VALUE));

  // 가장 엄격하게 하려면 아래 줄의 // 를 지운다: '2 필지 일부' 41건을 빼고 '1 필지 확정' 1,705건만 쓴다.
  // damageFC = damageFC.filter(ee.Filter.eq('loc_conf', '1 필지 확정'));

  // 필지 경계로 분류됐어도 geometry가 polygon이 아니면 면적 계산이 안 되므로 뺀다.
  var damageTyped = damageFC.map(function(feature) {
    return feature.set('dsg_geometry_type', feature.geometry().type());
  });
  var dsgPolygonFilter = ee.Filter.inList('dsg_geometry_type', ['Polygon', 'MultiPolygon']);
  var damageNonPolygon = damageTyped.filter(dsgPolygonFilter.not());
  damageFC = damageTyped.filter(dsgPolygonFilter);

  var dsgCountAll = damageAll.size();
  var dsgCountParcel = damageFC.size();

  print('===== D/S/G 1. 신고피해자료 필터링 =====');
  print('class_type별 개수 (필터 전 전체)', damageAll.aggregate_histogram('class_type'));
  print('전체 신고자료 개수', dsgCountAll);
  print('필지경계 polygon 개수 (분석에 사용)', dsgCountParcel);
  print('분석에서 제외된 자료 개수', dsgCountAll.subtract(dsgCountParcel));
  print('필지 경계지만 polygon이 아니라 제외된 개수', damageNonPolygon.size());
  print('필터 후 class_type 구성 (필지 경계만 있어야 함)',
    damageFC.aggregate_histogram('class_type'));
  print('필터 상태', ee.Algorithms.If(
    dsgCountParcel.eq(0),
    'WARNING: 필지 경계 자료가 0개입니다. asset ID 또는 class_type 한글 인코딩(.cpg 파일)을 확인하세요.',
    'OK'
  ));

  // -----------------------------------------------------------------------------
  // 2. 피해금액 및 PNU 속성 확인
  // -----------------------------------------------------------------------------
  // 이유: 같은 PNU에 신고가 여러 건이면 필지 단위로 합쳐야 피해금액과
  // 필지 수가 이중 계산되지 않는다. 피해금액이 없으면 0원이 아니라 null로 둔다.
  function dsgCleanAmount(value) {
    return ee.Algorithms.If(
      ee.Algorithms.IsEqual(value, null),
      null,
      ee.Algorithms.If(
        ZERO_DAMAGE_AS_MISSING ? ee.Number(value).gt(0) : ee.Number(value).gte(0),
        ee.Number(value),
        null
      )
    );
  }

  var damageReports = damageFC.map(function(feature) {
    return feature.set('dsg_amt_clean', dsgCleanAmount(feature.get('damage_amt')));
  });
  var damageReportsWithAmount = damageReports.filter(ee.Filter.notNull(['dsg_amt_clean']));
  var damageReportsWithPnu = damageReports.filter(ee.Filter.notNull(['PNU']));

  // PNU 하나당 polygon 하나만 남기고, 같은 PNU의 신고를 join으로 모은다.
  var dsgParcelsUnique = damageReportsWithPnu.distinct('PNU');
  var dsgPnuJoin = ee.Join.saveAll({matchesKey: 'dsg_reports'});
  var dsgParcelsJoined = ee.FeatureCollection(dsgPnuJoin.apply(
    dsgParcelsUnique,
    damageReportsWithPnu,
    ee.Filter.equals({leftField: 'PNU', rightField: 'PNU'})
  ));

  var dsgParcels = dsgParcelsJoined.map(function(feature) {
    var reports = ee.FeatureCollection(ee.List(feature.get('dsg_reports')));
    var reportsWithAmount = reports.filter(ee.Filter.notNull(['dsg_amt_clean']));
    var nWithAmount = reportsWithAmount.size();
    var sumFromReports = ee.Algorithms.If(
      nWithAmount.gt(0),
      reportsWithAmount.aggregate_sum('dsg_amt_clean'),
      null
    );
    // damage_sum 속성이 있으면 그것을 우선 쓰고, 없으면 신고별 금액을 합산한다.
    var damageSumClean = dsgCleanAmount(feature.get('damage_sum'));
    var damageValue = ee.Algorithms.If(
      ee.Algorithms.IsEqual(damageSumClean, null),
      sumFromReports,
      damageSumClean
    );

    return ee.Feature(feature.geometry(), {
      PNU: feature.get('PNU'),
      damage_amt: feature.get('damage_amt'),
      damage_sum: feature.get('damage_sum'),
      class_type: feature.get('class_type'),
      n_reports: reports.size(),
      n_reports_with_amount: nWithAmount,
      damage_sum_from_reports: sumFromReports,
      damage_value: damageValue
    });
  });

  var dsgDamageSumMismatch = dsgParcels
    .filter(ee.Filter.notNull(['damage_sum', 'damage_sum_from_reports']))
    .map(function(feature) {
      var difference = ee.Number(feature.get('damage_sum'))
        .subtract(ee.Number(feature.get('damage_sum_from_reports')))
        .abs();
      return feature.set('dsg_sum_difference', difference);
    })
    .filter(ee.Filter.gt('dsg_sum_difference', 0.5));

  print('===== D/S/G 2. 피해금액 및 PNU 확인 =====');
  print('첫 번째 필지경계 자료 (속성 이름 확인)', damageFC.first());
  // PNU는 19자리라 숫자로 저장되면 끝자리가 뭉개져 다른 필지가 합쳐질 수 있다.
  // 'String'이 아니면 asset을 만들 때 PNU를 문자(text) 필드로 다시 올려야 한다.
  print('PNU 자료형 (String이어야 함)', ee.Algorithms.ObjectType(damageFC.first().get('PNU')));
  print('PNU가 있는 필지경계 자료 개수', damageReportsWithPnu.size());
  print('PNU가 없는 필지경계 자료 개수 (필지 단위 분석에서 빠짐)',
    dsgCountParcel.subtract(damageReportsWithPnu.size()));
  print('damage_amt == 0 인 필지경계 자료 개수',
    damageFC.filter(ee.Filter.eq('damage_amt', 0)).size());
  print('피해금액이 존재하는 필지경계 자료 개수 (신고 단위)', damageReportsWithAmount.size());
  print('고유 PNU(필지) 개수', dsgParcels.size());
  print('같은 PNU에 신고가 2건 이상인 필지 개수',
    dsgParcels.filter(ee.Filter.gt('n_reports', 1)).size());
  print('피해금액이 존재하는 필지 개수 (PNU 단위)',
    dsgParcels.filter(ee.Filter.notNull(['damage_value'])).size());
  print('damage_sum 속성과 신고별 합산값이 다른 필지 개수 (0이 정상)',
    dsgDamageSumMismatch.size());

  // -----------------------------------------------------------------------------
  // 3. D/S/G binary layer 생성
  // -----------------------------------------------------------------------------
  // 이유: 세 자료를 같은 격자(10 m, 같은 projection·ROI·valid mask) 위의
  // 0/1 영상으로 맞춰야 픽셀 단위로 정확히 겹쳐 볼 수 있다.
  var dsgBase = ee.Image.constant(0)
    .toByte()
    .setDefaultProjection(dsgProjection);

  // D: 반드시 1단계에서 필터링한 필지경계 polygon(damageFC)만 rasterize한다.
  // 픽셀 중심이 필지 안에 들어야 1이 되므로 10 m보다 작은 필지는 빠질 수 있다.
  // 그래서 필지 단위 판단은 6~8단계의 면적 비율로 따로 한다.
  var dImage = dsgBase
    .paint({featureCollection: damageFC, color: 1})
    .rename('D')
    .toByte()
    .updateMask(validEvaluationMask)
    .clip(roi);

  // S: SAR 침수영역. 이미 0/1이지만 안전하게 gt(0)로 다시 binary화한다.
  var sImage = sarFlood
    .gt(0)
    .rename('S')
    .toByte()
    .updateMask(validEvaluationMask)
    .clip(roi);

  // G: 침수흔적도 vector를 baseline referenceFlood와 같은 방식으로 rasterize한다.
  var gImage = dsgBase
    .paint({featureCollection: floodTrace, color: 1})
    .rename('G')
    .toByte()
    .updateMask(validEvaluationMask)
    .clip(roi);

  // -----------------------------------------------------------------------------
  // 4. 3중 중첩 case image 생성
  // -----------------------------------------------------------------------------
  // 이유: D·S·G 조합 8가지를 숫자 하나(code = D*4 + S*2 + G)로 표현하면
  // 한 번의 grouped reduction으로 모든 조합의 면적을 셀 수 있다.
  var dsgCaseImage = dImage
    .multiply(4)
    .add(sImage.multiply(2))
    .add(gImage)
    .rename('dsg_case')
    .toByte();

  // D0 S0 G0(code 0)은 분석 대상이 아니므로 mask로 제외한다.
  var dsgCaseImageValid = dsgCaseImage.updateMask(dsgCaseImage.gt(0));

  // -----------------------------------------------------------------------------
  // 5. case별 면적 및 비율 계산 (10 m 픽셀 단위)
  // -----------------------------------------------------------------------------
  // 이유: 세 자료가 공간적으로 어디서 얼마나 겹치고 어긋나는지 면적으로 비교한다.
  // baseline과 같은 pixel-center 기반(unweighted) 집계를 쓴다.
  var dsgCaseMask = dsgCaseImageValid.mask();

  var dsgAreaGroupedStats = ee.Image.pixelArea()
    .divide(1e6)
    .rename('area_km2')
    .updateMask(dsgCaseMask)
    .addBands(ee.Image.constant(1).rename('pixels').updateMask(dsgCaseMask))
    .addBands(dsgCaseImageValid)
    .reduceRegion({
      reducer: ee.Reducer.sum()
        .unweighted()
        .repeat(2)
        .group({groupField: 2, groupName: 'dsg_case'}),
      geometry: roi,
      scale: DSG_SCALE,
      crs: dsgProjection,
      maxPixels: MAX_PIXELS,
      tileScale: TILE_SCALE
    });

  var dsgAreaGroups = ee.List(ee.Dictionary(dsgAreaGroupedStats).get('groups', ee.List([])));
  var dsgAreaLookup = ee.Dictionary.fromLists(
    dsgAreaGroups.map(function(group) {
      return ee.Number(ee.Dictionary(group).get('dsg_case')).format('%.0f');
    }),
    dsgAreaGroups.map(function(group) {
      return ee.Dictionary(group).get('sum');
    })
  );

  function dsgCaseArea(code) {
    return ee.Number(ee.List(dsgAreaLookup.get(String(code), ee.List([0, 0]))).get(0));
  }

  function dsgCasePixels(code) {
    return ee.Number(ee.List(dsgAreaLookup.get(String(code), ee.List([0, 0]))).get(1));
  }

  var dsgAllCaseAreaKm2 = ee.Number(0);
  var dsgDAreaKm2 = ee.Number(0);
  DSG_CASES.forEach(function(c) {
    dsgAllCaseAreaKm2 = dsgAllCaseAreaKm2.add(dsgCaseArea(c.code));
    if (c.D === 1) {
      dsgDAreaKm2 = dsgDAreaKm2.add(dsgCaseArea(c.code));
    }
  });

  var dsgCaseAreaTable = ee.FeatureCollection(DSG_CASES.map(function(c) {
    var area = dsgCaseArea(c.code);
    return ee.Feature(null, {
      case_code: c.code,
      case_key: c.key,
      case_label: c.label,
      group: c.group,
      D: c.D,
      S: c.S,
      G: c.G,
      pixels: dsgCasePixels(c.code),
      area_km2: area,
      share_of_all_cases: safeRatio(area, dsgAllCaseAreaKm2),
      share_within_D: c.D === 1 ? safeRatio(area, dsgDAreaKm2) : null
    });
  }));

  print('===== D/S/G 5. case별 면적 (10 m 픽셀) =====');
  print('case별 면적과 비율 (D0S0G0 제외)', dsgCaseAreaTable);
  print('7개 case 전체 면적 km2', dsgAllCaseAreaKm2);
  print('D=1 픽셀 면적 km2 (필지 rasterize 결과)', dsgDAreaKm2);

  // -----------------------------------------------------------------------------
  // 6. 신고 필지별 SAR overlap ratio
  // -----------------------------------------------------------------------------
  // 이유: SAR 픽셀 하나가 필지에 살짝 닿았다고 S=1로 보지 않기 위해,
  // 필지 안에서 실제로 겹친 면적의 비율로 판단한다.
  // reduceRegions의 sum은 기본이 가중합이라, 픽셀이 필지에 걸친 비율만큼만
  // 면적이 더해진다. 그래서 10 m보다 작은 필지도 비율이 계산된다.
  //
  // 분모(필지 면적)는 같은 10 m 격자에서 SAR 자료가 있는 부분의 면적(valid_area_m2)이다.
  // 필지 전체가 ROI 안에 있으면 벡터 면적(parcel_area_m2)과 거의 같고,
  // 비율이 1을 넘지 않는다. valid_coverage로 확인할 수 있다.
  var dsgSarStatsImage = ee.Image.pixelArea()
    .rename('valid_area_m2')
    .updateMask(validEvaluationMask)
    .clip(roi)
    .addBands(sImage.multiply(ee.Image.pixelArea()).rename('sar_area_m2'));

  var dsgParcelSar = dsgSarStatsImage.reduceRegions({
    collection: dsgParcels,
    reducer: ee.Reducer.sum().forEachBand(dsgSarStatsImage),
    scale: DSG_SCALE,
    crs: dsgProjection,
    tileScale: TILE_SCALE
  }).map(function(feature) {
    var validArea = dsgNumberOrZero(feature, 'valid_area_m2');
    var sarArea = dsgNumberOrZero(feature, 'sar_area_m2');
    var parcelArea = feature.geometry().area(1);
    return feature.set({
      parcel_area_m2: parcelArea,
      valid_area_m2: validArea,
      sar_area_m2: sarArea,
      valid_coverage: safeRatio(validArea, parcelArea),
      // SAR 자료가 전혀 없는 필지(ROI 밖 등)는 null로 두고 case에서 뺀다.
      sar_overlap_ratio: ee.Algorithms.If(
        validArea.gt(0),
        sarArea.divide(validArea).min(1),
        null
      )
    });
  });

  // -----------------------------------------------------------------------------
  // 7. 신고 필지별 침수흔적도 overlap ratio
  // -----------------------------------------------------------------------------
  // 이유: SAR와 같은 방법·같은 분모로 계산해야 두 비율을 직접 비교할 수 있다.
  var dsgTraceStatsImage = gImage
    .multiply(ee.Image.pixelArea())
    .rename('trace_area_m2');

  var dsgParcelSarTrace = dsgTraceStatsImage.reduceRegions({
    collection: dsgParcelSar,
    reducer: ee.Reducer.sum().setOutputs(['trace_area_m2']),
    scale: DSG_SCALE,
    crs: dsgProjection,
    tileScale: TILE_SCALE
  }).map(function(feature) {
    var validArea = dsgNumberOrZero(feature, 'valid_area_m2');
    var traceArea = dsgNumberOrZero(feature, 'trace_area_m2');
    return feature.set({
      trace_area_m2: traceArea,
      trace_overlap_ratio: ee.Algorithms.If(
        validArea.gt(0),
        traceArea.divide(validArea).min(1),
        null
      )
    });
  });

  // -----------------------------------------------------------------------------
  // 8. 필지별 D/S/G case 부여
  // -----------------------------------------------------------------------------
  // 이유: 모든 필지는 D=1이고, S와 G는 overlap ratio가 threshold 이상일 때만 1이다.
  // 같은 threshold를 S와 G에 똑같이 적용한다.
  function dsgFlag(ratio, threshold) {
    return ee.Algorithms.If(
      ee.Algorithms.IsEqual(ratio, null),
      null,
      ee.Algorithms.If(
        threshold === 0 ? ee.Number(ratio).gt(0) : ee.Number(ratio).gte(threshold),
        1,
        0
      )
    );
  }

  function dsgParcelCaseCode(sFlag, gFlag) {
    return ee.Algorithms.If(
      ee.Algorithms.IsEqual(sFlag, null),
      null,
      ee.Algorithms.If(
        ee.Algorithms.IsEqual(gFlag, null),
        null,
        ee.Number(4).add(ee.Number(sFlag).multiply(2)).add(ee.Number(gFlag))
      )
    );
  }

  function dsgThresholdKey(threshold) {
    var percent = Math.round(threshold * 100);
    return 'case_t' + (percent < 10 ? '0' + percent : String(percent));
  }

  var dsgParcelCases = dsgParcelSarTrace.map(function(feature) {
    var sarRatio = feature.get('sar_overlap_ratio');
    var traceRatio = feature.get('trace_overlap_ratio');
    var sFlag = dsgFlag(sarRatio, overlapThreshold);
    var gFlag = dsgFlag(traceRatio, overlapThreshold);
    var code = dsgParcelCaseCode(sFlag, gFlag);
    var codeKey = ee.Algorithms.If(
      ee.Algorithms.IsEqual(code, null),
      'no_data',
      ee.Number(code).format('%.0f')
    );

    var properties = {
      'D': 1,
      'S': sFlag,
      'G': gFlag,
      'case': code,
      'case_key': dsgCodeToKey.get(codeKey, 'NO_SAR_DATA'),
      'case_group': dsgCodeToGroup.get(codeKey, '-')
    };

    // 민감도 분석용: threshold마다 case를 따로 저장한다.
    sensitivityThresholds.forEach(function(threshold) {
      properties[dsgThresholdKey(threshold)] = dsgParcelCaseCode(
        dsgFlag(sarRatio, threshold),
        dsgFlag(traceRatio, threshold)
      );
    });

    return feature.set(properties);
  });

  print('===== D/S/G 8. 신고 필지별 case (threshold ' + overlapThreshold + ') =====');
  DSG_PARCEL_CODES.forEach(function(code) {
    var info = dsgCaseInfo(code);
    print(info.group + '. ' + info.label + ' 필지 수',
      dsgParcelCases.filter(ee.Filter.eq('case', code)).size());
  });
  print('SAR 자료가 없어 case를 줄 수 없는 필지 수 (ROI 밖 등)',
    dsgParcelCases.filter(ee.Filter.notNull(['case']).not()).size());
  print('SAR 자료가 필지 일부만 덮는 필지 수 (valid_coverage < 0.9)',
    dsgParcelCases.filter(ee.Filter.lt('valid_coverage', 0.9)).size());

  // threshold별 그룹 필지 수와 피해금액 합계
  var dsgSensitivityTable = ee.FeatureCollection(sensitivityThresholds.map(function(threshold) {
    var key = dsgThresholdKey(threshold);
    var row = {
      threshold: threshold,
      rule: threshold === 0 ? 'ratio > 0' : 'ratio >= ' + threshold
    };
    DSG_PARCEL_CODES.forEach(function(code) {
      var group = dsgCaseInfo(code).group;
      var parcels = dsgParcelCases.filter(ee.Filter.eq(key, code));
      var withAmount = parcels.filter(ee.Filter.notNull(['damage_value']));
      row[group + '_parcels'] = parcels.size();
      row[group + '_with_amount'] = withAmount.size();
      // 피해금액이 있는 필지가 없으면 0이 아니라 null로 둔다.
      row[group + '_damage_sum'] = ee.Algorithms.If(
        withAmount.size().gt(0),
        withAmount.aggregate_sum('damage_value'),
        null
      );
    });
    row.no_data_parcels = dsgParcelCases.filter(ee.Filter.notNull([key]).not()).size();
    return ee.Feature(null, row);
  }));

  print('threshold 민감도 비교표', dsgSensitivityTable);

  // -----------------------------------------------------------------------------
  // 9. case별 피해금액 통계
  // -----------------------------------------------------------------------------
  // 이유: 일치 유형에 따라 신고 피해 규모가 다른지 본다.
  // 피해금액이 있는 필지만 쓰고 null은 0으로 세지 않는다.
  // 큰 피해 몇 건이 평균을 끌어올릴 수 있으므로 중앙값을 함께 본다.
  function dsgDamageStats(parcels, groupName, caseKey) {
    var withAmount = parcels.filter(ee.Filter.notNull(['damage_value']));
    var n = withAmount.size();
    var sorted = ee.List(withAmount.aggregate_array('damage_value')).sort();
    var middle = n.divide(2).floor().toInt();
    var median = ee.Algorithms.If(
      n.eq(0),
      null,
      ee.Algorithms.If(
        n.mod(2).eq(1),
        sorted.get(middle),
        ee.Number(sorted.get(middle.subtract(1))).add(ee.Number(sorted.get(middle))).divide(2)
      )
    );

    return ee.Feature(null, {
      group: groupName,
      case_key: caseKey,
      n_parcels: parcels.size(),
      n_with_amount: n,
      damage_total: ee.Algorithms.If(n.gt(0), withAmount.aggregate_sum('damage_value'), null),
      damage_mean: ee.Algorithms.If(n.gt(0), withAmount.aggregate_mean('damage_value'), null),
      damage_median: median,
      damage_min: ee.Algorithms.If(n.gt(0), withAmount.aggregate_min('damage_value'), null),
      damage_max: ee.Algorithms.If(n.gt(0), withAmount.aggregate_max('damage_value'), null)
    });
  }

  var dsgDamageStatsRows = DSG_PARCEL_CODES.map(function(code) {
    var info = dsgCaseInfo(code);
    return dsgDamageStats(
      dsgParcelCases.filter(ee.Filter.eq('case', code)),
      info.group,
      info.key
    );
  });
  dsgDamageStatsRows.push(dsgDamageStats(
    dsgParcelCases.filter(ee.Filter.notNull(['case'])),
    'ALL (A~D)',
    'D1'
  ));
  dsgDamageStatsRows.push(dsgDamageStats(
    dsgParcelCases.filter(ee.Filter.notNull(['case']).not()),
    'NO_SAR_DATA',
    'none'
  ));
  var dsgDamageStatsTable = ee.FeatureCollection(dsgDamageStatsRows);

  print('===== D/S/G 9. case별 피해금액 통계 (threshold ' + overlapThreshold + ') =====');
  print('그룹별 필지 수 · 피해금액 합계 · 평균 · 중앙값 · 최소 · 최대', dsgDamageStatsTable);

  // -----------------------------------------------------------------------------
  // 10. 지도 시각화 및 legend
  // -----------------------------------------------------------------------------
  // 이유: 표의 숫자가 실제로 어디에서 나왔는지 지도에서 확인하기 위해서다.
  var dsgPixelPalette = [1, 2, 3, 4, 5, 6, 7].map(function(code) {
    return dsgCaseInfo(code).color;
  });

  Map.addLayer(
    dsgCaseImageValid,
    {min: 1, max: 7, palette: dsgPixelPalette},
    'D/S/G case (10 m pixels)',
    true
  );

  var dsgParcelStyled = dsgParcelCases.map(function(feature) {
    var code = feature.get('case');
    var colorKey = ee.Algorithms.If(
      ee.Algorithms.IsEqual(code, null),
      'no_data',
      ee.Number(code).format('%.0f')
    );
    var color = ee.String(dsgCodeToColor.get(colorKey));
    return feature.set('style', {color: color, fillColor: color.cat('AA'), width: 1});
  });

  Map.addLayer(
    dsgParcelStyled.style({styleProperty: 'style'}),
    {},
    'D/S/G case (reported parcels, overlap threshold ' + overlapThreshold + ')',
    true
  );
  Map.addLayer(
    damageFC.style({color: '000000', fillColor: '00000000', width: 1}),
    {},
    'D: reported parcel boundaries',
    false
  );

  var dsgLegend = ui.Panel({style: {position: 'bottom-left', padding: '8px 12px'}});
  dsgLegend.add(ui.Label({
    value: 'D/S/G case',
    style: {fontWeight: 'bold', fontSize: '14px', margin: '0 0 6px 0'}
  }));

  function dsgLegendRow(color, text) {
    return ui.Panel({
      widgets: [
        ui.Label({style: {backgroundColor: '#' + color, padding: '8px', margin: '0 6px 4px 0'}}),
        ui.Label({value: text, style: {fontSize: '12px', margin: '0 0 4px 0'}})
      ],
      layout: ui.Panel.Layout.Flow('horizontal')
    });
  }

  DSG_CASES.forEach(function(c) {
    var prefix = c.group === '-' ? '' : c.group + '. ';
    dsgLegend.add(dsgLegendRow(c.color, prefix + c.label));
  });
  dsgLegend.add(dsgLegendRow(DSG_NO_DATA_COLOR, 'Parcel: no SAR data'));
  Map.add(dsgLegend);

  // -----------------------------------------------------------------------------
  // 11. 결과 FeatureCollection 생성
  // -----------------------------------------------------------------------------
  // 이유: 필지마다 비율·판정·피해금액을 한 행에 붙여 두면
  // QGIS나 엑셀에서 바로 확인하고 다른 분석에 재사용할 수 있다.
  var dsgResultProperties = [
    'PNU', 'damage_amt', 'damage_sum', 'class_type',
    'sar_overlap_ratio', 'trace_overlap_ratio',
    'D', 'S', 'G', 'case', 'case_key', 'case_group',
    'damage_value', 'damage_sum_from_reports', 'n_reports', 'n_reports_with_amount',
    'parcel_area_m2', 'valid_area_m2', 'valid_coverage', 'sar_area_m2', 'trace_area_m2'
  ].concat(sensitivityThresholds.map(dsgThresholdKey));

  var damageParcelResult = dsgParcelCases.select(dsgResultProperties);

  print('===== D/S/G 11. 최종 결과 확인 =====');
  print('최종 결과 필지 개수', damageParcelResult.size());
  print('최종 결과 class_type 구성 (필지 경계만 있어야 함)',
    damageParcelResult.aggregate_histogram('class_type'));
  print('최종 결과 중 필지 경계가 아닌 자료 개수 (0이어야 함)',
    damageParcelResult.filter(ee.Filter.neq('class_type', PARCEL_CLASS_VALUE)).size());
  print('최종 결과 첫 행', damageParcelResult.first());

  // -----------------------------------------------------------------------------
  // 12. CSV · SHP · GeoJSON Export
  // -----------------------------------------------------------------------------
  // 이유: 포스터 표·그래프와 QGIS 지도 작업에 쓰기 위해서다.
  // Tasks 탭에서 RUN을 눌러야 실제로 Drive에 저장된다.
  Export.table.toDrive({
    collection: damageParcelResult,
    description: 'Hapcheon_DSG_parcels_CSV',
    folder: DSG_EXPORT_FOLDER,
    fileNamePrefix: 'Hapcheon_DSG_parcels',
    fileFormat: 'CSV'
  });

  // SHP는 필드 이름이 10자까지라 짧은 이름으로 바꿔서 내보낸다.
  var dsgShpLongNames = [
    'PNU', 'damage_amt', 'damage_sum', 'class_type',
    'sar_overlap_ratio', 'trace_overlap_ratio',
    'D', 'S', 'G', 'case', 'case_key', 'case_group',
    'damage_value', 'n_reports', 'valid_coverage'
  ];
  var dsgShpShortNames = [
    'PNU', 'dmg_amt', 'dmg_sum', 'class_type',
    'sar_ratio', 'trc_ratio',
    'D', 'S', 'G', 'case_code', 'case_key', 'case_grp',
    'dmg_value', 'n_reports', 'valid_cov'
  ];

  // select(긴 이름, 짧은 이름)은 비어 있는(null) 속성이 하나라도 있는 필지에서 실패한다.
  // (피해금액이 없는 필지는 damage_value가 비어 있음)
  // 그래서 필지마다 속성을 하나씩 꺼내 짧은 이름으로 다시 붙인다. 빈 값은 빈칸으로 저장된다.
  var dsgShpCollection = damageParcelResult.map(function(feature) {
    var shpProperties = {};
    dsgShpLongNames.forEach(function(name, index) {
      shpProperties[dsgShpShortNames[index]] = feature.get(name);
    });
    return ee.Feature(feature.geometry(), shpProperties);
  });

  Export.table.toDrive({
    collection: dsgShpCollection,
    description: 'Hapcheon_DSG_parcels_SHP',
    folder: DSG_EXPORT_FOLDER,
    fileNamePrefix: 'Hapcheon_DSG_parcels',
    fileFormat: 'SHP'
  });

  // SHP 내보내기가 Tasks에서 실패하면(Polygon·MultiPolygon이 섞인 경우 등) 이 파일을 쓴다.
  // QGIS에서 바로 열리고, 긴 필드 이름과 한글이 그대로 남는다.
  Export.table.toDrive({
    collection: damageParcelResult,
    description: 'Hapcheon_DSG_parcels_GeoJSON',
    folder: DSG_EXPORT_FOLDER,
    fileNamePrefix: 'Hapcheon_DSG_parcels',
    fileFormat: 'GeoJSON'
  });

  Export.table.toDrive({
    collection: dsgCaseAreaTable,
    description: 'Hapcheon_DSG_case_area_CSV',
    folder: DSG_EXPORT_FOLDER,
    fileNamePrefix: 'Hapcheon_DSG_case_area',
    fileFormat: 'CSV'
  });

  Export.table.toDrive({
    collection: dsgDamageStatsTable,
    description: 'Hapcheon_DSG_damage_stats_CSV',
    folder: DSG_EXPORT_FOLDER,
    fileNamePrefix: 'Hapcheon_DSG_damage_stats',
    fileFormat: 'CSV'
  });

  Export.table.toDrive({
    collection: dsgSensitivityTable,
    description: 'Hapcheon_DSG_threshold_sensitivity_CSV',
    folder: DSG_EXPORT_FOLDER,
    fileNamePrefix: 'Hapcheon_DSG_threshold_sensitivity',
    fileFormat: 'CSV'
  });

  // =============================================================================
  // 13. D/S/G 결과 차트 (콘솔에 5개가 순서대로 나온다)
  // -----------------------------------------------------------------------------
  // 위에서 계산한 결과만 가져와 그리므로 분석 결과는 바뀌지 않는다.
  //   차트 1. 신고 필지가 A·B·C·D 중 어디에 속하나 (핵심 결과)
  //   차트 2. 필지마다 SAR·흔적도와 얼마나 겹쳤나 (왜 그 유형이 됐나)
  //   차트 3. 겹침 기준을 바꾸면 비율이 어떻게 변하나 (민감도)
  //   차트 4. 유형별 피해금액 (중앙값 막대 + 평균 점)
  //   차트 5. 10 m 픽셀 기준 D/S/G 조합 면적
  // =============================================================================

  var dsgChartThresholdText = (overlapThreshold === 0 ? '> 0' : '≥ ' + Math.round(overlapThreshold * 100)) + '%';

  function dsgChartComma(value) {
    return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function dsgChartPercent(part, total) {
    return total > 0 ? (part / total * 100).toFixed(1) + '%' : '-';
  }

  function dsgChartGroupLabel(code) {
    var short = {7: 'Report + SAR + Trace map', 6: 'Report + SAR', 5: 'Report + Trace map', 4: 'Report only'};
    return dsgCaseInfo(code).group + '. ' + short[code];
  }

  // 차트에 필요한 숫자를 한 번에 가져온다.
  var dsgChartData = ee.Dictionary({
    parcelCounts: ee.Dictionary.fromLists(
      DSG_PARCEL_CODES.map(function(code) { return String(code); }),
      DSG_PARCEL_CODES.map(function(code) {
        return dsgParcelCases.filter(ee.Filter.eq('case', code)).size();
      })
    ),
    noData: dsgParcelCases.filter(ee.Filter.notNull(['case']).not()).size(),
    scatter: dsgParcelCases
      .filter(ee.Filter.notNull(['case']))
      .reduceColumns(ee.Reducer.toList(3), ['trace_overlap_ratio', 'sar_overlap_ratio', 'case'])
      .get('list'),
    sensitivity: ee.List(sensitivityThresholds.map(function(threshold) {
      var key = dsgThresholdKey(threshold);
      return ee.Dictionary.fromLists(
        DSG_PARCEL_CODES.map(function(code) { return String(code); }),
        DSG_PARCEL_CODES.map(function(code) {
          return dsgParcelCases.filter(ee.Filter.eq(key, code)).size();
        })
      );
    })),
    damage: ee.List(dsgDamageStatsRows.slice(0, 4).map(function(row) {
      return row.toDictionary();
    })),
    area: ee.Dictionary.fromLists(
      DSG_CASES.map(function(c) { return String(c.code); }),
      DSG_CASES.map(function(c) { return dsgCaseArea(c.code); })
    )
  });

  print('===== D/S/G 13. 결과 차트 (불러오는 중...) =====');

  dsgChartData.evaluate(function(data, error) {
    if (error) {
      print('차트 데이터 오류', error);
      return;
    }

    // ---------------------------------------------------------------------------
    // 차트 1. 신고 필지 유형 분포
    // ---------------------------------------------------------------------------
    var parcelTotal = 0;
    DSG_PARCEL_CODES.forEach(function(code) { parcelTotal += data.parcelCounts[String(code)]; });

    var chart1Table = [[
      {role: 'domain', type: 'string', label: 'Type'},
      {role: 'data', type: 'number', label: 'Parcels'},
      {role: 'style', type: 'string'},
      {role: 'annotation', type: 'string'}
    ]];
    DSG_PARCEL_CODES.forEach(function(code) {
      var n = data.parcelCounts[String(code)];
      chart1Table.push([
        dsgChartGroupLabel(code),
        n,
        'color: #' + dsgCaseInfo(code).color,
        dsgChartComma(n) + ' (' + dsgChartPercent(n, parcelTotal) + ')'
      ]);
    });

    print(ui.Chart(chart1Table, 'ColumnChart', {
      title: '① D/S/G type of ' + dsgChartComma(parcelTotal) + ' reported parcels (overlap ' + dsgChartThresholdText + ')',
      legend: {position: 'none'},
      hAxis: {title: dsgChartComma(data.noData) + ' parcels without SAR data excluded'},
      vAxis: {title: 'Number of parcels', viewWindow: {min: 0}},
      annotations: {alwaysOutside: true, textStyle: {fontSize: 12, bold: true, color: '#222222'}},
      bar: {groupWidth: '65%'}
    }));

    // ---------------------------------------------------------------------------
    // 차트 2. 필지별 겹침 비율 산점도 (점선 = 겹침 기준)
    // 오른쪽 위 = A, 왼쪽 위 = B, 오른쪽 아래 = C, 왼쪽 아래 = D
    // ---------------------------------------------------------------------------
    var plotCodes = DSG_PARCEL_CODES;
    var chart2Header = [{role: 'domain', type: 'number', label: 'Overlap with flood trace map'}];
    plotCodes.forEach(function(code) {
      chart2Header.push({role: 'data', type: 'number', label: dsgChartGroupLabel(code)});
    });
    chart2Header.push({role: 'data', type: 'number', label: 'Threshold'});
    chart2Header.push({role: 'data', type: 'number', label: 'Threshold '});
    var chart2Table = [chart2Header];
    var emptyCells = plotCodes.map(function() { return null; });

    data.scatter.forEach(function(item) {
      var traceRatio = item[0];
      var sarRatio = item[1];
      var code = Math.round(item[2]);
      var row = [traceRatio].concat(plotCodes.map(function(c) { return c === code ? sarRatio : null; }));
      chart2Table.push(row.concat([null, null]));
    });
    // 기준선: 세로선 두 점, 가로선 두 점 (각각 이어서 그린다)
    chart2Table.push([overlapThreshold].concat(emptyCells, [0, null]));
    chart2Table.push([overlapThreshold].concat(emptyCells, [1, null]));
    chart2Table.push([0].concat(emptyCells, [null, overlapThreshold]));
    chart2Table.push([1].concat(emptyCells, [null, overlapThreshold]));

    var chart2Series = {};
    plotCodes.forEach(function(code, index) {
      chart2Series[index] = {color: '#' + dsgCaseInfo(code).color, pointSize: 5};
    });
    chart2Series[plotCodes.length] = {
      color: '#555555', pointSize: 0, lineWidth: 1.5, lineDashStyle: [4, 4], visibleInLegend: false
    };
    chart2Series[plotCodes.length + 1] = {
      color: '#555555', pointSize: 0, lineWidth: 1.5, lineDashStyle: [4, 4], visibleInLegend: false
    };

    print(ui.Chart(chart2Table, 'ScatterChart', {
      title: '② Overlap of each reported parcel with SAR and the flood trace map (dashed line = ' + dsgChartThresholdText + ')',
      hAxis: {title: 'Share of parcel area within the flood trace map', viewWindow: {min: 0, max: 1}, format: '#%'},
      vAxis: {title: 'Share of parcel area within the SAR flood area', viewWindow: {min: 0, max: 1}, format: '#%'},
      series: chart2Series,
      dataOpacity: 0.6,
      legend: {position: 'right'}
    }));

    // ---------------------------------------------------------------------------
    // 차트 3. 겹침 기준별 유형 비율 (100% 누적 막대)
    // ---------------------------------------------------------------------------
    var chart3Header = [{role: 'domain', type: 'string', label: 'Overlap threshold'}];
    DSG_PARCEL_CODES.forEach(function(code) {
      chart3Header.push({role: 'data', type: 'number', label: dsgChartGroupLabel(code)});
    });
    var chart3Table = [chart3Header];
    sensitivityThresholds.forEach(function(threshold, index) {
      var counts = data.sensitivity[index];
      var label = threshold === 0 ? '> 0%' : '≥ ' + Math.round(threshold * 100) + '%';
      chart3Table.push([label].concat(DSG_PARCEL_CODES.map(function(code) {
        return counts[String(code)];
      })));
    });

    print(ui.Chart(chart3Table, 'ColumnChart', {
      title: '③ Sensitivity of D/S/G types to the overlap threshold',
      isStacked: 'percent',
      colors: DSG_PARCEL_CODES.map(function(code) { return '#' + dsgCaseInfo(code).color; }),
      hAxis: {title: 'Minimum share of parcel area that must overlap'},
      vAxis: {title: 'Share of reported parcels', format: '#%'},
      legend: {position: 'right'},
      bar: {groupWidth: '60%'}
    }));

    // ---------------------------------------------------------------------------
    // 차트 4. 유형별 피해금액 (피해금액이 있는 필지만)
    // ---------------------------------------------------------------------------
    var chart4Table = [[
      {role: 'domain', type: 'string', label: 'Type'},
      {role: 'data', type: 'number', label: 'Median'},
      {role: 'style', type: 'string'},
      {role: 'annotation', type: 'string'},
      {role: 'data', type: 'number', label: 'Mean'}
    ]];
    DSG_PARCEL_CODES.forEach(function(code, index) {
      var stats = data.damage[index] || {};
      var n = stats.n_with_amount || 0;
      var median = (stats.damage_median === undefined) ? null : stats.damage_median;
      var mean = (stats.damage_mean === undefined) ? null : stats.damage_mean;
      chart4Table.push([
        dsgChartGroupLabel(code),
        median,
        'color: #' + dsgCaseInfo(code).color,
        'n=' + n + (median === null ? '' : ' · median ' + dsgChartComma(median)),
        mean
      ]);
    });

    print(ui.Chart(chart4Table, 'ComboChart', {
      title: '④ Damage amount by type (bar = median, ◆ = mean, n = parcels with a damage amount)',
      seriesType: 'bars',
      series: {
        0: {color: '#9E9E9E'},
        1: {type: 'line', lineWidth: 0, pointSize: 10, pointShape: 'diamond', color: '#222222'}
      },
      hAxis: {title: 'A mean far above the median means a few large losses pull the mean up'},
      vAxis: {title: 'Damage amount (' + DSG_DAMAGE_UNIT_LABEL + ')', viewWindow: {min: 0}},
      annotations: {alwaysOutside: true, textStyle: {fontSize: 11, color: '#222222'}},
      legend: {position: 'top'},
      bar: {groupWidth: '60%'}
    }));

    // ---------------------------------------------------------------------------
    // 차트 5. 10 m 픽셀 기준 D/S/G 조합 면적
    // ---------------------------------------------------------------------------
    var areaTotal = 0;
    DSG_CASES.forEach(function(c) { areaTotal += data.area[String(c.code)]; });

    var chart5Table = [[
      {role: 'domain', type: 'string', label: 'Combination'},
      {role: 'data', type: 'number', label: 'Area (km²)'},
      {role: 'style', type: 'string'},
      {role: 'annotation', type: 'string'}
    ]];
    DSG_CASES.forEach(function(c) {
      var area = data.area[String(c.code)];
      chart5Table.push([
        (c.group === '-' ? '' : c.group + '. ') + c.label,
        area,
        'color: #' + c.color,
        area.toFixed(2) + ' km² (' + dsgChartPercent(area, areaTotal) + ')'
      ]);
    });

    print(ui.Chart(chart5Table, 'BarChart', {
      title: '⑤ Area of each D/S/G combination at 10 m pixels (D0 S0 G0 excluded)',
      legend: {position: 'none'},
      hAxis: {title: 'Area (km²)', viewWindow: {min: 0}},
      annotations: {alwaysOutside: true, textStyle: {fontSize: 11, color: '#222222'}},
      chartArea: {left: 230},
      bar: {groupWidth: '70%'}
    }));
  });

  // ===========================================================================
  // [추가] B 그룹 놓친 부분 폴리곤 + A·B 토지피복 분석
  // 원본에서 바뀐 곳은 이 호출 한 줄뿐이다. 함수 정의는 파일 맨 끝에 있다.
  // dsgParcelCases·sImage·gImage가 모두 만들어진 뒤라서 함수의 맨 끝에서 호출한다.
  // ===========================================================================
  runGroupBLandcoverAnalysis(dsgParcelCases, sImage, gImage);

  // [추가 2] 홍수 전(7월 27일) 영상과 비교. 함수 정의는 파일 맨 끝에 있다.
  runPrePostComparison(dsgParcelCases, sImage, gImage);
}

// =============================================================================
// 실행: 신고피해 필지 asset이 GEE에 있는지 먼저 확인한다.
// 있으면 1~13단계를 실행하고, 없으면 오류 대신 해결 방법을 보여 준다.
// =============================================================================
var dsgAssetInfo = null;
try {
  dsgAssetInfo = ee.data.getAsset(DAMAGE_ASSET_ID);
} catch (assetError) {
  dsgAssetInfo = null;
}

if (dsgAssetInfo) {
  runDamageSarTraceAnalysis();
} else {
  print('===== D/S/G 분석을 실행하지 못했습니다: 신고피해 필지 asset이 GEE에 없습니다 =====');
  print('코드가 찾는 asset 경로', DAMAGE_ASSET_ID);
  print('해결 1', 'Assets 탭 → NEW → Shape files → Hapcheon_damage_parcels.zip 선택 → UPLOAD');
  print('해결 2', 'Tasks 탭에서 Hapcheon_damage_parcels 업로드(Ingest)가 끝날 때까지 기다린 뒤 다시 Run');
  print('해결 3', '다른 이름으로 올렸다면 아래 목록에서 그 경로를 복사해 DAMAGE_ASSET_ID에 붙여넣기');

  var dsgAssetParent = DAMAGE_ASSET_ID.split('/').slice(0, -1).join('/');
  try {
    var dsgAssetListing = ee.data.listAssets(dsgAssetParent);
    var dsgAllAssets = (dsgAssetListing && dsgAssetListing.assets) ? dsgAssetListing.assets : [];
    var dsgTableIds = dsgAllAssets
      .filter(function(asset) { return /table/i.test(String(asset.type)); })
      .map(function(asset) { return asset.id || asset.name; });
    print('지금 ' + dsgAssetParent + ' 안에 있는 table asset', dsgTableIds.length ? dsgTableIds : '(없음)');
  } catch (listError) {
    print('asset 목록을 읽지 못했습니다', String(listError));
  }
}
