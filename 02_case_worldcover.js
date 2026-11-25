// =============================================================================
// 합천 2020 홍수: Sentinel-1 SAR · 침수흔적도 · 신고피해 공간적 일치성 분석 (Google Earth Engine)
// 파트 2/5 — 케이스별 토지피복 분석 (ESA WorldCover)
// -----------------------------------------------------------------------------
// ESA WorldCover 2020을 불러와 Otsu 결과 케이스별 토지피복 구성과 시가지(Built-up) 요약 계산
// 선행 파일: 01 (floodCandidate, referenceFlood, safeRatio 등 사용)
//
// 실행 방법: GEE Code Editor에서 01 → 05 파일을 순서대로 하나의 스크립트에 이어 붙여 실행한다.
//           (GEE 스크립트는 파일끼리 변수를 공유하지 않으므로 파일 하나만 따로 실행하면 오류가 난다.)
// =============================================================================

// 2. ESA WorldCover 2020 v100
// Dataset ID: ESA/WorldCover/v100
// Dataset type: ImageCollection
// Band: Map
// Native pixel size: 10 m
//
// Official class values are retained without analytical reclassification.
var hapcheonWorldCover = ee.Image( ee.ImageCollection( 'ESA/WorldCover/v100' ).first() ) .select('Map') .rename('landcover_value') .toInt16() .updateMask(validEvaluationMask) .clip(evaluationRoi);
var hapcheonWorldCoverValues = ee.List([ 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100 ]);
var hapcheonWorldCoverNames = ee.List([ 'Tree cover', 'Shrubland', 'Grassland', 'Cropland', 'Built-up', 'Bare / sparse vegetation', 'Snow and ice', 'Permanent water bodies', 'Herbaceous wetland', 'Mangroves', 'Moss and lichen' ]);
function getHapcheonWorldCoverName( classValue ) {
classValue = ee.Number(classValue).toInt();
var classIndex = ee.Number( hapcheonWorldCoverValues.indexOf( classValue ) );
return ee.Algorithms.If( classIndex.gte(0), hapcheonWorldCoverNames.get( classIndex ), 'Unknown WorldCover class' );
}
var hapcheonWorldCoverVis = {
min: 10, max: 100, palette: [ '006400', 'FFBB22', 'FFFF4C', 'F096FF', 'FA0000', 'B4B4B4', 'F0F0F0', '0064C8', '0096A0', '00CF75', 'FAE6A0' ] };
Map.addLayer( hapcheonWorldCover, hapcheonWorldCoverVis, 'ESA WorldCover 2020', false );
// HAPCHEON OTSU BASELINE: THREE-CASE SPATIAL RELATIONSHIP ANALYSIS
// -----------------------------------------------------------------------------
// Paste this block at the very end of the existing script, after the final
// Map.onClick(...); block. It reuses the unchanged Otsu-baseline objects.
//
// Required existing objects:
// tp, fn, outsideGt, TP, FN, OutsideGT,
// tpAreaKm2, fnAreaKm2, outsideGtAreaKm2,
// floodCandidate, referenceFlood, validEvaluationMask,
// evaluationRoi, analysisProjection, EVAL_SCALE, MAX_PIXELS, TILE_SCALE,
// hapcheonPolygonTable, floodCollection, floodReferenceImage,
// hapcheonSlopeBinCode, hapcheonSlopeBinCodes, hapcheonSlopeBinLabels,
// hapcheonSlopeBinMinimums, hapcheonSlopeBinMaximums,
// hapcheonWorldCover, hapcheonWorldCoverValues,
// getHapcheonWorldCoverName(), safeRatio().
//
// Terminology:
// referenceFlood == 0 means "no mapped flood-trace information".
// CASE 3 is therefore named "Outside-GT detection".

// 1. CASE metadata and baseline summary
var otsuCaseIds = ee.List([1, 2, 3]);
var otsuCaseNames = ee.List([
  'Mapped flood detected by SAR',
  'SAR-missed mapped flood',
  'Outside-GT detection'
]);
var otsuCaseSarValues = ee.List([1, 0, 1]);
var otsuCaseFloodTraceValues = ee.List([1, 1, 0]);
var otsuCasePixelTotals = ee.List([TP, FN, OutsideGT]);
var otsuCaseAreaTotalsKm2 = ee.List([
  tpAreaKm2,
  fnAreaKm2,
  outsideGtAreaKm2
]);
var otsuCaseDenominatorDescriptions = ee.List([
  'mapped flood-trace pixels (TP + FN)',
  'mapped flood-trace pixels (TP + FN)',
  'all SAR-detected flood pixels (TP + OutsideGT)'
]);

function otsuCaseListIndex(caseId) {
  return ee.Number(caseId).subtract(1).toInt();
}

function getOtsuCaseName(caseId) {
  return otsuCaseNames.get(otsuCaseListIndex(caseId));
}

function getOtsuCasePixelTotal(caseId) {
  return ee.Number(otsuCasePixelTotals.get(otsuCaseListIndex(caseId)));
}

function getOtsuCaseAreaTotalKm2(caseId) {
  return ee.Number(otsuCaseAreaTotalsKm2.get(otsuCaseListIndex(caseId)));
}

function otsuCaseSafePercent(numerator, denominator) {
  numerator = ee.Number(numerator);
  denominator = ee.Number(denominator);
  return ee.Algorithms.If(
    denominator.gt(0),
    numerator.divide(denominator).multiply(100),
    null
  );
}

var otsuCaseGt1TotalPixels = TP.add(FN);
var otsuCaseSar1TotalPixels = TP.add(OutsideGT);

var otsuThreeCaseSummary = ee.FeatureCollection(
  otsuCaseIds.map(function(caseId) {
    caseId = ee.Number(caseId).toInt();
    var index = otsuCaseListIndex(caseId);
    var pixels = getOtsuCasePixelTotal(caseId);
    var denominator = ee.Number(ee.Algorithms.If(
      caseId.lte(2),
      otsuCaseGt1TotalPixels,
      otsuCaseSar1TotalPixels
    ));

    return ee.Feature(null, {
      case_id: caseId,
      case_name: getOtsuCaseName(caseId),
      SAR_value: otsuCaseSarValues.get(index),
      flood_trace_value: otsuCaseFloodTraceValues.get(index),
      pixels: pixels,
      area_km2: getOtsuCaseAreaTotalKm2(caseId),
      denominator_description: otsuCaseDenominatorDescriptions.get(index),
      share: safeRatio(pixels, denominator)
    });
  })
).sort('case_id');

print('===== OTSU BASELINE THREE-CASE SUMMARY =====');
print('Otsu baseline three-case summary table', otsuThreeCaseSummary);
print('GT1 total pixels = TP + FN', otsuCaseGt1TotalPixels);
print('CASE1 percentage of mapped flood-trace pixels',
  otsuCaseSafePercent(TP, otsuCaseGt1TotalPixels));
print('CASE2 percentage of mapped flood-trace pixels',
  otsuCaseSafePercent(FN, otsuCaseGt1TotalPixels));
print('SAR1 total pixels = TP + OutsideGT', otsuCaseSar1TotalPixels);
print('CASE3 percentage of all SAR-detected flood pixels',
  otsuCaseSafePercent(OutsideGT, otsuCaseSar1TotalPixels));

// 2. One grouped reduction for CASE x ESA WorldCover
// case code: 0 = excluded, 1 = TP, 2 = FN, 3 = Outside-GT detection.
var otsuCaseCode = ee.Image.constant(0)
  .setDefaultProjection(analysisProjection)
  .toByte()
  .updateMask(validEvaluationMask)
  .where(tp.eq(1), 1)
  .where(fn.eq(1), 2)
  .where(outsideGt.eq(1), 3)
  .rename('case_code')
  .clip(evaluationRoi);

// The official WorldCover value is retained in the lower three digits.
var otsuCaseLandcoverCode = otsuCaseCode
  .multiply(1000)
  .add(hapcheonWorldCover)
  .rename('case_landcover_code')
  .toInt32()
  .updateMask(otsuCaseCode.gt(0))
  .updateMask(hapcheonWorldCover.mask());

var otsuCaseLandcoverPixelBand = ee.Image.constant(1)
  .setDefaultProjection(analysisProjection)
  .rename('pixels')
  .toByte()
  .updateMask(otsuCaseLandcoverCode.mask());

var otsuCaseLandcoverAreaBand = ee.Image.pixelArea()
  .divide(1e6)
  .rename('area_km2')
  .updateMask(otsuCaseLandcoverCode.mask());

var otsuCaseLandcoverGroupedStats = otsuCaseLandcoverPixelBand
  .addBands(otsuCaseLandcoverAreaBand)
  .addBands(otsuCaseLandcoverCode)
  .reduceRegion({
    reducer: ee.Reducer.sum()
      .unweighted()
      .repeat(2)
      .group({
        groupField: 2,
        groupName: 'case_landcover_code'
      }),
    geometry: evaluationRoi,
    scale: EVAL_SCALE,
    crs: analysisProjection,
    maxPixels: MAX_PIXELS,
    tileScale: TILE_SCALE
  });

var otsuCaseLandcoverGroups = ee.List(
  ee.Dictionary(otsuCaseLandcoverGroupedStats)
    .get('groups', ee.List([]))
);

var otsuCaseLandcoverGroupKeys = otsuCaseLandcoverGroups.map(
  function(group) {
    return ee.Number(
      ee.Dictionary(group).get('case_landcover_code')
    ).format('%.0f');
  }
);

var otsuCaseLandcoverGroupValues = otsuCaseLandcoverGroups.map(
  function(group) {
    return ee.Dictionary(group).get('sum');
  }
);

var otsuCaseLandcoverLookup = ee.Dictionary.fromLists(
  otsuCaseLandcoverGroupKeys,
  otsuCaseLandcoverGroupValues
);

// Build all 3 x 11 combinations so absent classes remain as explicit zeros.
var otsuAllCaseLandcoverCodes = ee.List(
  otsuCaseIds.map(function(caseId) {
    caseId = ee.Number(caseId).toInt();
    return hapcheonWorldCoverValues.map(function(landcoverValue) {
      landcoverValue = ee.Number(landcoverValue).toInt();
      return caseId.multiply(1000).add(landcoverValue).toInt();
    });
  }).flatten()
);

var otsuCaseLandcoverTable = ee.FeatureCollection(
  otsuAllCaseLandcoverCodes.map(function(combinedCode) {
    combinedCode = ee.Number(combinedCode).toInt();
    var caseId = combinedCode.divide(1000).floor().toInt();
    var landcoverValue = combinedCode.mod(1000).toInt();
    var sums = ee.List(otsuCaseLandcoverLookup.get(
      combinedCode.format('%.0f'),
      ee.List([0, 0])
    ));
    var pixels = ee.Number(sums.get(0));
    var areaKm2 = ee.Number(sums.get(1));

    return ee.Feature(null, {
      case_id: caseId,
      case_name: getOtsuCaseName(caseId),
      landcover_value: landcoverValue,
      landcover_name: getHapcheonWorldCoverName(landcoverValue),
      pixels: pixels,
      area_km2: areaKm2,
      share_within_case: safeRatio(
        pixels,
        getOtsuCasePixelTotal(caseId)
      )
    });
  })
).sort('case_id');

print('===== OTSU THREE-CASE ESA WORLDCOVER COMPOSITION =====');
print('CASE1/CASE2/CASE3 x 11 WorldCover classes',
  otsuCaseLandcoverTable);

// 3. Built-up (class 50) summary, reusing the grouped table
var otsuBuiltUpSummary = ee.FeatureCollection(
  otsuCaseIds.map(function(caseId) {
    caseId = ee.Number(caseId).toInt();
    var row = ee.Feature(
      otsuCaseLandcoverTable
        .filter(ee.Filter.eq('case_id', caseId))
        .filter(ee.Filter.eq('landcover_value', 50))
        .first()
    );

    return ee.Feature(null, {
      case_id: caseId,
      case_name: getOtsuCaseName(caseId),
      built_up_pixels: row.get('pixels'),
      built_up_area_km2: row.get('area_km2'),
      built_up_share_within_case: row.get('share_within_case')
    });
  })
).sort('case_id');

print('===== OTSU THREE-CASE BUILT-UP SUMMARY =====');
print('Built-up (WorldCover class 50) by case', otsuBuiltUpSummary);

// 7. Validation derived from the output tables
var otsuCaseValidationTable = ee.FeatureCollection(
  otsuCaseIds.map(function(caseId) {
    caseId = ee.Number(caseId).toInt();
    var expectedPixels = getOtsuCasePixelTotal(caseId);
    var summaryRow = ee.Feature(
      otsuThreeCaseSummary
        .filter(ee.Filter.eq('case_id', caseId))
        .first()
    );
    var summaryPixels = ee.Number(summaryRow.get('pixels'));
    var landcoverRows = otsuCaseLandcoverTable
      .filter(ee.Filter.eq('case_id', caseId));
    var landcoverPixels = ee.Number(
      landcoverRows.aggregate_sum('pixels')
    );
    var builtUpRow = ee.Feature(
      landcoverRows
        .filter(ee.Filter.eq('landcover_value', 50))
        .first()
    );
    var builtUpPixels = ee.Number(builtUpRow.get('pixels'));
    var otherOfficialClassPixels = landcoverPixels
      .subtract(builtUpPixels);
    var builtPlusOther = builtUpPixels
      .add(otherOfficialClassPixels);

    return ee.Feature(null, {
      case_id: caseId,
      case_name: getOtsuCaseName(caseId),
      expected_baseline_pixels: expectedPixels,
      case_summary_pixels: summaryPixels,
      case_summary_minus_expected: summaryPixels
        .subtract(expectedPixels),
      case_summary_equals_expected: summaryPixels
        .eq(expectedPixels),
      landcover_pixels_sum: landcoverPixels,
      worldcover_no_data_pixels: expectedPixels
        .subtract(landcoverPixels),
      landcover_sum_equals_case_total: landcoverPixels
        .eq(expectedPixels),
      built_up_pixels: builtUpPixels,
      other_official_class_pixels: otherOfficialClassPixels,
      built_plus_other_pixels: builtPlusOther,
      built_plus_other_equals_landcover_sum: builtPlusOther
        .eq(landcoverPixels),
      built_plus_other_equals_case_total: builtPlusOther
        .eq(expectedPixels),
      built_plus_other_plus_no_data_equals_case_total: builtPlusOther
        .add(expectedPixels.subtract(landcoverPixels))
        .eq(expectedPixels)
    });
  })
).sort('case_id');

var otsuValidationCase1Pixels = ee.Number(
  ee.Feature(
    otsuThreeCaseSummary
      .filter(ee.Filter.eq('case_id', 1))
      .first()
  ).get('pixels')
);
var otsuValidationCase2Pixels = ee.Number(
  ee.Feature(
    otsuThreeCaseSummary
      .filter(ee.Filter.eq('case_id', 2))
      .first()
  ).get('pixels')
);
var otsuValidationCase3Pixels = ee.Number(
  ee.Feature(
    otsuThreeCaseSummary
      .filter(ee.Filter.eq('case_id', 3))
      .first()
  ).get('pixels')
);
var otsuValidationCase1 = ee.Feature(
  otsuCaseValidationTable
    .filter(ee.Filter.eq('case_id', 1))
    .first()
);
var otsuValidationCase2 = ee.Feature(
  otsuCaseValidationTable
    .filter(ee.Filter.eq('case_id', 2))
    .first()
);
var otsuValidationCase3 = ee.Feature(
  otsuCaseValidationTable
    .filter(ee.Filter.eq('case_id', 3))
    .first()
);

print('===== OTSU THREE-CASE VALIDATION =====');
print('Per-case summary, WorldCover no-data, and Built-up + other validation',
  otsuCaseValidationTable);
print('CASE1 pixel sum == TP',
  otsuValidationCase1Pixels.eq(TP));
print('CASE2 pixel sum == FN',
  otsuValidationCase2Pixels.eq(FN));
print('CASE3 pixel sum == OutsideGT',
  otsuValidationCase3Pixels.eq(OutsideGT));
print('CASE1 land-cover pixels sum == TP',
  otsuValidationCase1.get('landcover_sum_equals_case_total'));
print('CASE2 land-cover pixels sum == FN',
  otsuValidationCase2.get('landcover_sum_equals_case_total'));
print('CASE3 land-cover pixels sum == OutsideGT',
  otsuValidationCase3.get('landcover_sum_equals_case_total'));
print('CASE1 WorldCover no-data pixels',
  otsuValidationCase1.get('worldcover_no_data_pixels'));
print('CASE2 WorldCover no-data pixels',
  otsuValidationCase2.get('worldcover_no_data_pixels'));
print('CASE3 WorldCover no-data pixels',
  otsuValidationCase3.get('worldcover_no_data_pixels'));
print('CASE1 + CASE2 pixels',
  otsuValidationCase1Pixels.add(otsuValidationCase2Pixels));
print('TP + FN pixels', TP.add(FN));
print('CASE1 + CASE2 == TP + FN',
  otsuValidationCase1Pixels
    .add(otsuValidationCase2Pixels)
    .eq(TP.add(FN)));
print('CASE1 + CASE3 pixels (simple sum check only)',
  otsuValidationCase1Pixels.add(otsuValidationCase3Pixels));
print('TP + OutsideGT pixels (simple sum check only)',
  TP.add(OutsideGT));
print('CASE1 + CASE3 == TP + OutsideGT (simple sum check only)',
  otsuValidationCase1Pixels
    .add(otsuValidationCase3Pixels)
    .eq(TP.add(OutsideGT)));

// 8. Charts reuse the FeatureCollections above; no new reductions are run.
var otsuCaseLandcoverChartTable = otsuCaseLandcoverTable
  .filter(
    ee.Filter.inList(
      'landcover_value',
      [10, 30, 40, 50, 60, 80]
    )
  );

var otsuCaseWorldCoverCompositionChart = ui.Chart.feature.groups(
  otsuCaseLandcoverChartTable,
  'landcover_name',
  'share_within_case',
  'case_name'
)
  .setChartType('ColumnChart')
  .setOptions({
    title: 'Otsu baseline: WorldCover composition by case',
    hAxis: {
      title: 'ESA WorldCover class',
      slantedText: true,
      slantedTextAngle: 45
    },
    vAxis: {
      title: 'Share within case (0-1)',
      viewWindow: {min: 0}
    },
    legend: {position: 'top'},
    bar: {groupWidth: '75%'}
  });
var otsuBuiltUpShareChart = ui.Chart.feature.byFeature({
  features: otsuBuiltUpSummary,
  xProperty: 'case_name',
  yProperties: ['built_up_share_within_case']
})
  .setChartType('ColumnChart')
  .setOptions({
    title: 'Otsu baseline: Built-up share by case',
    hAxis: {
      title: 'Case',
      slantedText: true,
      slantedTextAngle: 25
    },
    vAxis: {
      title: 'Built-up share within case (0-1)',
      viewWindow: {min: 0}
    },
    legend: {position: 'none'},
    colors: ['FA0000']
  });

print('Otsu three-case WorldCover composition chart',
  otsuCaseWorldCoverCompositionChart);
print('Otsu three-case Built-up share chart',
  otsuBuiltUpShareChart);

// 9. Additional map layers only; selfMask() is used only for display.
var otsuBuiltUpMaskForDisplay = hapcheonWorldCover
  .eq(50)
  .rename('built_up_display');

var otsuCase2BuiltUpForDisplay = fn
  .and(hapcheonWorldCover.eq(50))
  .rename('case2_built_up_display');

Map.addLayer(
  tp.selfMask(),
  {palette: ['00C853']},
  'CASE1 - GT1 & SAR1',
  false
);
Map.addLayer(
  fn.selfMask(),
  {palette: ['FFD600']},
  'CASE2 - GT1 & SAR0 (SAR-missed mapped flood)',
  true
);
Map.addLayer(
  outsideGt.selfMask(),
  {palette: ['D50000']},
  'CASE3 - SAR1 outside flood-trace map (Outside-GT detection)',
  false
);
Map.addLayer(
  otsuBuiltUpMaskForDisplay.selfMask(),
  {palette: ['FA0000']},
  'ESA WorldCover Built-up (class 50)',
  false
);
Map.addLayer(
  otsuCase2BuiltUpForDisplay.selfMask(),
  {palette: ['AA00FF']},
  'CASE2 AND Built-up',
  true
);
print(
  'WorldCover interpretation note',
  'ESA WorldCover v100 represents 2020 land cover and is temporally matched to the 2020 Hapcheon flood event.'
);
