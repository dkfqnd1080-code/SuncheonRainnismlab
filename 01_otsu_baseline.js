// =============================================================================
// 합천 2020 홍수: Sentinel-1 SAR · 침수흔적도 · 신고피해 공간적 일치성 분석 (Google Earth Engine)
// 파트 1/5 — Otsu 기준 분석
// -----------------------------------------------------------------------------
// Sentinel-1 VV(궤도 61, 2020-08-09 06:24 KST) 선택 → 5x5 Lee 필터 → Otsu 임계값으로 침수 후보 추출
// 침수흔적도(Trace)와 겹쳐 TP / 흔적도 밖 탐지 / FN 면적과 일치 지표 계산
// 선행 파일: 없음 (이 파일이 맨 앞)
//
// 실행 방법: GEE Code Editor에서 01 → 05 파일을 순서대로 하나의 스크립트에 이어 붙여 실행한다.
//           (GEE 스크립트는 파일끼리 변수를 공유하지 않으므로 파일 하나만 따로 실행하면 오류가 난다.)
// =============================================================================

// Sentinel-1 VV + 5x5 Lee filter + Otsu baseline
// Study area: Hapcheon, Republic of Korea
// 목적:
// 용인 baseline과 동일한 핵심 분석조건으로 합천 VV Otsu 성능을 평가한다.
//
// 이 스크립트에는 VH, Before/Post 변화량, DEM, slope, land cover,
// permanent water mask, threshold 최적화 또는 머신러닝을 포함하지 않는다.
// 0. USER PARAMETERS: 실행 전에 반드시 실제 값으로 교체
// 합천 침수흔적도 Polygon/MultiPolygon FeatureCollection asset ID
// 예: projects/your-project/assets/hapcheon_flood_trace
var HAPCHEON_GT_ASSET_ID = 'projects/flood1-507003/assets/Hapcheon_2020';
// filterDate()의 종료일은 포함되지 않는다.
var FLOOD_START = '2020-08-08';
var FLOOD_END = '2020-08-09';
var ORBIT_PASS = 'DESCENDING';
var RELATIVE_ORBIT = 61;
// 용인 baseline과 동일한 평가/히스토그램 설정
var EVAL_SCALE = 10;
var MAX_PIXELS = 1e9;
var TILE_SCALE = 4;
var HIST_MAX_BUCKETS = 256;
var HIST_MIN_BUCKET_WIDTH = 0.1;
var HIST_MAX_RAW = 1e6;
var EPS = 1e-12;
// 1. Hapcheon ground-truth FeatureCollection
// HAPCHEON_GT_ASSET_ID는 vector FeatureCollection이어야 한다.
// FeatureCollection을 ee.Image()로 불러오지 않는다.
var hapcheonFloodTable = ee.FeatureCollection( HAPCHEON_GT_ASSET_ID );
print( 'Hapcheon GT total feature count', hapcheonFloodTable.size() );
print( 'Hapcheon GT first feature', hapcheonFloodTable.first() );
var hapcheonTableWithType = hapcheonFloodTable.map( function(feature) { return feature.set( 'geometry_type', feature.geometry().type() ); } );
print( 'Hapcheon GT geometry-type histogram', hapcheonTableWithType.aggregate_histogram('geometry_type') );
var hapcheonPolygonTable = hapcheonTableWithType.filter( ee.Filter.inList( 'geometry_type', ['Polygon', 'MultiPolygon'] ) );
print( 'Hapcheon GT polygon feature count', hapcheonPolygonTable.size() );
// 현재 ROI는 baseline 비교용 임시 ROI이며,
// 최종 연구에서는 공식 조사범위/행정경계/독립적으로 정의된
// 분석영역으로 교체해야 함.
var evaluationRoi = hapcheonPolygonTable .geometry() .bounds(1);
print( 'Hapcheon evaluation ROI', evaluationRoi );
print( 'Hapcheon evaluation ROI area km2', evaluationRoi.area(1).divide(1e6) );
Map.centerObject(evaluationRoi, 11);
// 2. Sentinel-1 scene selection
var hapcheonS1 = ee.ImageCollection('COPERNICUS/S1_GRD') .filterBounds(evaluationRoi) .filter(ee.Filter.eq('instrumentMode', 'IW')) .filter(ee.Filter.eq('resolution_meters', 10)) .filter(ee.Filter.eq('orbitProperties_pass', ORBIT_PASS)) .filter( ee.Filter.eq( 'relativeOrbitNumber_start', RELATIVE_ORBIT ) ) .filter( ee.Filter.listContains( 'transmitterReceiverPolarisation', 'VV' ) );
var floodCollection = hapcheonS1 .filterDate(FLOOD_START, FLOOD_END) .sort('system:index');
print( 'Hapcheon Flood scene count', floodCollection.size() );
// 각 scene의 핵심 acquisition 정보를 표 형태로 출력한다.
function makeHapcheonAcquisitionTable( collection, periodLabel ) {
var imageList = collection.toList(collection.size());
return ee.FeatureCollection(imageList.map(function(object) { var image = ee.Image(object); return ee.Feature(null, { period: periodLabel, 'system:index': image.get('system:index'), 'system:time_start': image.get('system:time_start'), acquisition_utc: ee.Date( image.get('system:time_start') ).format('YYYY-MM-dd HH:mm:ss'), platform_number: image.get('platform_number'), orbitProperties_pass: image.get('orbitProperties_pass'), relativeOrbitNumber_start: image.get('relativeOrbitNumber_start') }); }));
}
var floodAcquisitionTable = makeHapcheonAcquisitionTable( floodCollection, 'Flood' );
print( 'Hapcheon Flood acquisition metadata', floodAcquisitionTable );
// 파라미터 설정 후 각 collection에 최소 1개 이상의 scene이 있어야 한다.
var floodReferenceImage = ee.Image( floodCollection.first() );
var analysisProjection = floodReferenceImage .select('VV') .projection();
print( 'Hapcheon analysis CRS', analysisProjection.crs() );
print( 'Hapcheon analysis transform', analysisProjection.transform() );
print( 'Hapcheon nominal scale', analysisProjection.nominalScale() );
// 3. Deterministic mosaics
// collection은 system:index로 정렬되어 있다.
// mosaic()은 마지막 유효 픽셀을 우선하므로 overlap 우선순위가 재현 가능하다.
var flood = floodCollection .mosaic() .setDefaultProjection(analysisProjection);
var floodVV = flood .select('VV') .rename('Flood_VV_dB');
// 4. Identical 5x5 Lee-filter functions
function dbToLinearPower(dbImage) {
return ee.Image.constant(10) .pow(dbImage.divide(10)) .rename('VV_linear') .updateMask(dbImage.mask());
}
function linearPowerToDb(powerImage, outputName) {
return powerImage .max(EPS) .log10() .multiply(10) .rename(outputName) .updateMask(powerImage.mask());
}
// 고전적 multiplicative Lee MMSE filter
// Cu²는 ROI 내 5x5 local CV²의 10th percentile로 고정 추정한다.
function leeFilter5x5Linear(linearImage, roi) {
var kernel5x5 = ee.Kernel.square({ radius: 2, units: 'pixels', normalize: false });
var localMean = linearImage.reduceNeighborhood({ reducer: ee.Reducer.mean(), kernel: kernel5x5, skipMasked: true }).rename('local_mean');
var localVariance = linearImage.reduceNeighborhood({ reducer: ee.Reducer.variance(), kernel: kernel5x5, skipMasked: true }).rename('local_variance');
var localCvSquared = localVariance .divide(localMean.pow(2).max(EPS)) .rename('local_cv2') .updateMask(localMean.gt(EPS));
var noiseStatistics = localCvSquared.reduceRegion({ reducer: ee.Reducer.percentile([10]), geometry: roi, scale: EVAL_SCALE, crs: analysisProjection, maxPixels: MAX_PIXELS, tileScale: TILE_SCALE });
var noiseEstimateValid = noiseStatistics.size().gt(0);
// 0.25는 empty ROI에서 계산 graph를 유지하기 위한 fallback이다.
// 이 경우 이후 valid mask에서 평가가 제외된다.
var noiseCvSquared = ee.Number( ee.Algorithms.If( noiseEstimateValid, noiseStatistics.values().get(0), 0.25 ) ).max(EPS);
var signalVariance = localVariance .subtract( localMean.pow(2).multiply(noiseCvSquared) ) .divide( ee.Number(1).add(noiseCvSquared) ) .max(0);
var weight = signalVariance .divide(localVariance.max(EPS)) .clamp(0, 1);
var filtered = localMean .add( weight.multiply( linearImage.subtract(localMean) ) ) .rename('VV_Lee_linear') .updateMask(linearImage.mask());
return filtered.set({ lee_window: '5x5', lee_noise_cv2: noiseCvSquared, lee_noise_estimate_valid: noiseEstimateValid, lee_noise_estimator: '10th percentile of local 5x5 CV^2' });
}
var floodVVLinear = dbToLinearPower(floodVV);
var floodVVLeeLinear = leeFilter5x5Linear( floodVVLinear, evaluationRoi );
var floodVVLeeDb = linearPowerToDb( floodVVLeeLinear, 'VV_Lee_dB' ).set({ lee_noise_cv2: floodVVLeeLinear.get('lee_noise_cv2'), lee_noise_estimate_valid: floodVVLeeLinear.get('lee_noise_estimate_valid') });
print( 'Hapcheon Lee noise CV2', floodVVLeeDb.get('lee_noise_cv2') );
print( 'Hapcheon Lee noise estimate valid', floodVVLeeDb.get('lee_noise_estimate_valid') );
var leeNoiseValid = ee.Number( ee.Algorithms.If( floodVVLeeDb.get('lee_noise_estimate_valid'), 1, 0 ) );
// 5. Hapcheon Flood VV histogram and Otsu threshold
var histogramResult = floodVVLeeDb.reduceRegion({ reducer: ee.Reducer.histogram({ maxBuckets: HIST_MAX_BUCKETS, minBucketWidth: HIST_MIN_BUCKET_WIDTH, maxRaw: HIST_MAX_RAW }), geometry: evaluationRoi, scale: EVAL_SCALE, crs: analysisProjection, maxPixels: MAX_PIXELS, tileScale: TILE_SCALE });
var fallbackHistogram = ee.Dictionary({ histogram: [0, 0], bucketMeans: [-30, -10] });
var histogramPresent = histogramResult.size().gt(0);
var vvHistogram = ee.Dictionary( ee.Algorithms.If( histogramPresent, histogramResult.values().get(0), fallbackHistogram ) );
// 두 class의 between-class variance가 최대인 split을 선택한다.
function otsuFromHistogram(histogramDictionary) {
var dictionary = ee.Dictionary( histogramDictionary );
var counts = ee.Array( dictionary.get('histogram', [0, 0]) );
var means = ee.Array( dictionary.get('bucketMeans', [-30, -10]) );
var meansList = ee.List(means.toList());
var numberOfBuckets = meansList.size();
var totalCount = ee.Number( counts .reduce(ee.Reducer.sum(), [0]) .get([0]) );
var totalSum = ee.Number( means .multiply(counts) .reduce(ee.Reducer.sum(), [0]) .get([0]) );
var basicValid = numberOfBuckets .gt(1) .and(totalCount.gt(0));
var splitIndices = ee.List( ee.Algorithms.If( basicValid, ee.List.sequence( 1, numberOfBuckets.subtract(1) ), ee.List([]) ) );
var betweenClassVariances = splitIndices.map( function(index) { index = ee.Number(index); var classACounts = counts.slice( 0, 0, index ); var classAMeans = means.slice( 0, 0, index ); var classACount = ee.Number( classACounts .reduce(ee.Reducer.sum(), [0]) .get([0]) ); var classASum = ee.Number( classAMeans .multiply(classACounts) .reduce(ee.Reducer.sum(), [0]) .get([0]) ); var classBCount = totalCount.subtract( classACount ); var classBSum = totalSum.subtract( classASum ); var validClasses = classACount .gt(0) .and(classBCount.gt(0)); var classAMean = ee.Number( ee.Algorithms.If( classACount.gt(0), classASum.divide(classACount), 0 ) ); var classBMean = ee.Number( ee.Algorithms.If( classBCount.gt(0), classBSum.divide(classBCount), 0 ) ); var globalMean = ee.Number( ee.Algorithms.If( totalCount.gt(0), totalSum.divide(totalCount), 0 ) ); var bss = classACount .multiply( classAMean .subtract(globalMean) .pow(2) ) .add( classBCount.multiply( classBMean .subtract(globalMean) .pow(2) ) ); return ee.Number( ee.Algorithms.If( validClasses, bss, -1 ) ); } );
var maximumBss = ee.Number( ee.Algorithms.If( basicValid, ee.List(betweenClassVariances) .reduce(ee.Reducer.max()), -1 ) );
var validSplit = basicValid.and( maximumBss.gte(0) );
var maximumPosition = ee.Number( ee.Algorithms.If( validSplit, ee.List(betweenClassVariances) .indexOf(maximumBss), 0 ) );
var splitIndex = ee.Number( ee.Algorithms.If( validSplit, splitIndices.get(maximumPosition), 1 ) );
// 선택된 두 인접 bucket mean의 중간값
var threshold = ee.Number( ee.Algorithms.If( validSplit, ee.Number( meansList.get( splitIndex.subtract(1) ) ) .add( ee.Number( meansList.get(splitIndex) ) ) .divide(2), -9999 ) );
return ee.Dictionary({ valid: ee.Number( ee.Algorithms.If(validSplit, 1, 0) ), threshold_dB: threshold, total_histogram_pixel_count: totalCount, bucket_count: numberOfBuckets, maximum_between_class_variance: maximumBss });
}
var otsuResult = otsuFromHistogram(vvHistogram);
// 합천 Flood VV histogram에서 새로 계산한 threshold이다.
// 용인에서 계산된 threshold를 재사용하지 않는다.
var otsuThreshold = ee.Number( otsuResult.get('threshold_dB') );
var otsuValid = ee.Number( otsuResult.get('valid') );
print( 'Hapcheon Otsu histogram dictionary', vvHistogram );
print( 'Hapcheon Otsu calculation status', otsuResult );
print( 'Hapcheon Otsu threshold dB', otsuThreshold );
var histogramChart = ui.Chart.image.histogram({ image: floodVVLeeDb, region: evaluationRoi, scale: EVAL_SCALE, maxBuckets: HIST_MAX_BUCKETS, minBucketWidth: HIST_MIN_BUCKET_WIDTH, maxRaw: HIST_MAX_RAW, maxPixels: MAX_PIXELS }).setOptions({ title: 'Hapcheon Flood VV Lee-filtered Histogram', hAxis: { title: 'VV backscatter (dB)' }, vAxis: { title: 'Pixel count' }, legend: { position: 'none' }, colors: ['3366CC'] });
print( 'Hapcheon Flood VV Lee-filtered Histogram', histogramChart );
// 6. Prediction and valid evaluation mask
var validEvaluationMask = floodVVLeeDb .mask() .and(ee.Image.constant(leeNoiseValid)) .and(ee.Image.constant(otsuValid));
// 평가용 prediction은 0과 1을 모두 유지하며 selfMask()를 사용하지 않는다.
var floodCandidate = floodVVLeeDb .lte(otsuThreshold) .rename('prediction') .toByte() .updateMask(validEvaluationMask) .clip(evaluationRoi);
// 7. Ground-truth rasterization
var referenceBase = ee.Image.constant(0) .toByte() .setDefaultProjection(analysisProjection);
var referenceFlood = referenceBase .paint({ featureCollection: hapcheonPolygonTable, color: 1 })
.rename('reference') .updateMask(validEvaluationMask) .clip(evaluationRoi);
// 8. Reference comparison and area
// IMPORTANT GT INTERPRETATION:
// 침수흔적도 내부는 기록된 침수 reference로 사용한다.
// 침수흔적도 외부는 verified non-flood가 아니다.
// 따라서 prediction == Flood && outside GT 영역은 FP로 단정하지 않고
// 'Outside-GT detection'으로 정의한다.
// 실제 FP 여부는 독립적인 비침수 근거가 있을 때만 판단한다.
var tp = floodCandidate.eq(1) .and(referenceFlood.eq(1)) .rename('TP');
// Outside-GT detection = predicted flood outside the mapped flood-trace polygons.
var outsideGt = floodCandidate.eq(1) .and(referenceFlood.eq(0)) .rename('OutsideGT');
var fn = floodCandidate.eq(0) .and(referenceFlood.eq(1)) .rename('FN');
var tn = floodCandidate.eq(0) .and(referenceFlood.eq(0)) .rename('TN');
var confusionBands = ee.Image.cat([ tp, outsideGt, fn, tn ]).toByte();
var areaBandsKm2 = confusionBands .multiply(ee.Image.pixelArea()) .divide(1e6) .rename([ 'TP_area_km2', 'OutsideGT_area_km2', 'FN_area_km2', 'TN_area_km2' ]);
var assessmentStats = confusionBands .addBands(areaBandsKm2) .reduceRegion({
// 용인 baseline과 동일한 pixel-center 기반 이산 raster 평가
reducer: ee.Reducer.sum().unweighted(), geometry: evaluationRoi, scale: EVAL_SCALE, crs: analysisProjection, maxPixels: MAX_PIXELS, tileScale: TILE_SCALE });
var TP = ee.Number( assessmentStats.get('TP', 0) );
var OutsideGT = ee.Number( assessmentStats.get('OutsideGT', 0) );
var FN = ee.Number( assessmentStats.get('FN', 0) );
var TN = ee.Number( assessmentStats.get('TN', 0) );
var tpAreaKm2 = ee.Number( assessmentStats.get('TP_area_km2', 0) );
var outsideGtAreaKm2 = ee.Number( assessmentStats.get('OutsideGT_area_km2', 0) );
var fnAreaKm2 = ee.Number( assessmentStats.get('FN_area_km2', 0) );
var tnAreaKm2 = ee.Number( assessmentStats.get('TN_area_km2', 0) );
// 분모가 0이면 null을 반환한다.
function safeRatio(numerator, denominator) {
numerator = ee.Number(numerator);
denominator = ee.Number(denominator);
return ee.Algorithms.If( denominator.gt(0), numerator.divide(denominator), null );
}
// Precision/F1/IoU below are reference-based comparison metrics under the same GT assumption.
var precision = safeRatio( TP, TP.add(OutsideGT) );
var recall = safeRatio( TP, TP.add(FN) );
// 2TP / (2TP + OutsideGT + FN)은 2PR / (P + R)과 동일하다.
var f1Score = safeRatio( TP.multiply(2), TP.multiply(2).add(OutsideGT).add(FN) );
var iou = safeRatio( TP, TP.add(OutsideGT).add(FN) );
var evaluatedPixelCount = TP .add(OutsideGT) .add(FN) .add(TN);
// 9. Final Hapcheon baseline result
var hapcheonBaselineResult = ee.Feature(null, { region: 'Hapcheon', polarization: 'VV', otsu_threshold_dB: otsuThreshold, evaluated_pixel_count: evaluatedPixelCount, TP: TP, OutsideGT: OutsideGT, FN: FN, TN: TN, Precision: precision, Recall: recall, F1_score: f1Score, IoU: iou, TP_area_km2: tpAreaKm2, OutsideGT_area_km2: outsideGtAreaKm2, FN_area_km2: fnAreaKm2, TN_area_km2: tnAreaKm2 });
print( '===== HAPCHEON VV OTSU BASELINE =====', hapcheonBaselineResult );
// 10. Map layers
var vvVis = {
min: -25, max: 0 };
var candidateVis = {
palette: ['00FFFF'] };
var tpVis = {
palette: ['00C853'] };
var outsideGtVis = {
palette: ['FF0000'] };
var fnVis = {
palette: ['FFD600'] };
var hapcheonRoiOutline = ee.FeatureCollection([ ee.Feature(evaluationRoi) ]).style({ color: 'FFFFFF', fillColor: '00000000', width: 2 });
Map.addLayer( hapcheonPolygonTable.style({ color: 'FF8800', fillColor: '00000000', width: 3 }), {}, 'Hapcheon GT flood trace', true );
Map.addLayer( hapcheonRoiOutline, {}, 'Evaluation ROI', false );
Map.addLayer( floodVV.clip(evaluationRoi), vvVis, 'Flood VV', true );
Map.addLayer( floodVVLeeDb.clip(evaluationRoi), vvVis, 'Flood VV Lee filtered', true );
// selfMask()는 아래 지도 시각화에만 사용한다.
Map.addLayer( floodCandidate.selfMask(), candidateVis, 'Otsu Flood Candidate', false );
Map.addLayer( tp.selfMask(), tpVis, 'TP', false );
Map.addLayer( outsideGt.selfMask(), outsideGtVis, 'Outside-GT detection', true );
Map.addLayer( fn.selfMask(), fnVis, 'FN', true );
