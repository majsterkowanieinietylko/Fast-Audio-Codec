/*
	FAC - Fast Audio Codec software written by MINT: https://www.youtube.com/@__MINT_
	
	This codec consists of two encoders and one decoder compatible with both encoders.
	One encoder allows for very fast, possibly real-time compression with acceptable
	quality and operates on 8-bit samples only. The other, slower one is intended for
	offline applications and provides higher quality and flexibility. It operates on
	audio with bit depth from 4 to 16 bits and performs a lot of error analysis for
	both numerical and perceptual errors. Audio quality is better compared to ADPCM.
	
	Decoder is even faster than basic ADPCM decoder. It works the same way no matter
	the bit depth nor set quality, most inner loop run for every sample has just
	3 lines and is branchless. The only branch taken during the whole decoding process
	is left for safety reasons. You don't wanna blow up your ears in case of an error.
	FAC can run on AVR microcontrollers with no problem, possibly even on Z80. SPI flash
	memory will be enough for audio storage in most cases.
	With 16kHz sample rate, 2-bits per sample and single audio channel FAC can squeeze
	over 2 hours of audio into 8 MB.
    
    Encoding function:
        
        fac_encode({channelData, sampleRate, bitDepth, bitsPerSample, slice_len, frame_slices, quality})
            Arguments (input object members):
                @ channelData: array of arrays holding audio samples for each channel. For example [[audio_L], [audio_R]].
                    Up to 255 channels supported. Fast encoder expects 8-bit signed PCM format, slower encoder can take anything
                    with bit depth from 4 to 16 bits (signed input, obviously).
                @ sampleRate: input audio sample rate, 24-bit unsigned number. Defaults to 44100 if not given.
                @ bitDepth: input audio bit depth, range [4-16]. Defaults to 8 if not given.
                @ bitsPerSample: bits per encoded audio sample, range [1-4]. Defaults to 3 if not given.
                @ slice_len: number of samples assigned to each scalefactor, range [1-255]. Defaults to 24 if not given.
                @ frame_slices: number of slices per frame, range [1-65535]. defaults to 2048 if not given.
                @ quality: quality grade, range [0-10]. 0 implies using fast 8-bit encoder, higher values imply 
                    using slower encoder. The higher the value, the better the sound quality.
            Returns:
                Uint8Array (so just an array of bytes) representing encoded audio.
                
    Decoding function:
        
        fac_decode(data)
            Arguments:
                @ data: Uint8Array (so just an array of bytes) representing encoded audio.
            Returns (returned object members):
                @ channelData: array of arrays holding audio samples for each channel. For example [[audio_L], [audio_R]]. 16-bit signed PCM format.
                @ channels: number of channels in the decoded audio, same as channelData.length
                @ samples: total number of samples in one channe.
                @ sampleRate: decoded audio sample rate.
                @ bitDepth: decoded audio bit depth.
                @ bitsPerSample: bits per sample used in encoded audio
                
	
	This software is provided "as is" and comes with absolutely no warranty!
*/


/* ================================ LUTs for fast encoder ================================= */

const inverse_tab_fast = [128, 64, 43, 32, 26, 21, 18, 16, 14, 13, 12, 11, 10, 9, 8, 7];
/*
	Table holding inverse scalefactors which are used to quantize residual values.
	Scalefactor table itself is trivial and looks like [1, 2, 3, 4, ... , 15, 16].
	Having scalefactors inversed here, we can use multiplication instead of slow
	division. Values are actually not 1/scalefactor, but rounded 128/scalefactor.
*/

let quant_tab_fast = [ // Mapping of quantized residual values, from -8 to 8
  [0, 0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3],			// 2-bit
  [0, 0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6, 6, 7, 7, 7],			// 3-bit
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 15]	// 4-bit
];
/*
	Example: in 3-bit mode, values -8 and -7 are mapped to 0, values -6, -5
	are mapped to 1, -4 and -3 is mapped to 2, etc.
	For 1-bit mode mapping is trivial: residual < 0 -> 0, residual >= 0 -> 1
	Yes, there is a disproportion between positive and negative values,
	but not having a neutral (0) element is even worse. Constant oscillations
	around certain value with audible Nyquist frequency would be a nightmare!
*/

let dequant_tab_fast = [
    [[-1, 1], [-5, 5], [-9, 9], [-14, 14], [-18, 18], [-22, 22], [-26, 26], [-30, 30],
    [-35, 35], [-39, 39], [-43, 43], [-47, 47], [-51, 51], [-56, 56], [-60, 60], [-64, 64]],

    [[-5, -1, 1, 5], [-11, -3, 3, 11], [-16, -4, 4, 16], [-22, -6, 6, 22],
    [-28, -8, 8, 28], [-33, -9, 9, 33], [-39, -11, 11, 39], [-45, -13, 13, 45],
    [-50, -14, 14, 50], [-56, -16, 16, 56], [-62, -18, 18, 62], [-67, -19, 19, 67],
    [-73, -21, 21, 73], [-79, -22, 22, 79], [-84, -24, 24, 84], [-90, -26, 26, 90]],

    [[-8, -6, -3, -1, 0, 1, 3, 7], [-15, -11, -7, -3, 0, 3, 7, 13],
    [-23, -17, -10, -4, 0, 4, 10, 20], [-30, -22, -14, -6, 0, 6, 14, 26],
    [-38, -28, -17, -7, 0, 7, 17, 33], [-45, -33, -21, -9, 0, 9, 21, 39],
    [-53, -39, -24, -10, 0, 10, 24, 46], [-60, -44, -28, -12, 0, 12, 28, 52],
    [-68, -50, -31, -13, 0, 13, 31, 59], [-75, -55, -35, -15, 0, 15, 35, 65],
    [-83, -61, -38, -16, 0, 16, 38, 72], [-90, -66, -42, -18, 0, 18, 42, 78],
    [-98, -72, -45, -19, 0, 19, 45, 85], [-105, -77, -49, -21, 0, 21, 49, 91],
    [-113, -83, -53, -22, 0, 22, 53, 98], [-120, -88, -56, -24, 0, 24, 56, 104]],

    [[-8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 8],
    [-16, -14, -12, -10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10, 12, 15],
    [-24, -21, -18, -15, -12, -9, -6, -3, 0, 3, 6, 9, 12, 15, 18, 23],
    [-32, -28, -24, -20, -16, -12, -8, -4, 0, 4, 8, 12, 16, 20, 24, 30],
    [-40, -35, -30, -25, -20, -15, -10, -5, 0, 5, 10, 15, 20, 25, 30, 38],
    [-48, -42, -36, -30, -24, -18, -12, -6, 0, 6, 12, 18, 24, 30, 36, 45],
    [-56, -49, -42, -35, -28, -21, -14, -7, 0, 7, 14, 21, 28, 35, 42, 53],
    [-64, -56, -48, -40, -32, -24, -16, -8, 0, 8, 16, 24, 32, 40, 48, 60],
    [-72, -63, -54, -45, -36, -27, -18, -9, 0, 9, 18, 27, 36, 45, 54, 68],
    [-80, -70, -60, -50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50, 60, 75],
    [-88, -77, -66, -55, -44, -33, -22, -11, 0, 11, 22, 33, 44, 55, 66, 83],
    [-96, -84, -72, -60, -48, -36, -24, -12, 0, 12, 24, 36, 48, 60, 72, 90],
    [-104, -91, -78, -65, -52, -39, -26, -13, 0, 13, 26, 39, 52, 65, 78, 98],
    [-112, -98, -84, -70, -56, -42, -28, -14, 0, 14, 28, 42, 56, 70, 84, 105],
    [-120, -105, -90, -75, -60, -45, -30, -15, 0, 15, 30, 45, 60, 75, 90, 113],
    [-128, -112, -96, -80, -64, -48, -32, -16, 0, 16, 32, 48, 64, 80, 96, 120]]
];
/* 	
	Mapping of quantized values to dequantized ones based on scalefactor,
	used bit width and quantized value. Table is included in the encoded file,
	allowing to use different tables based on audio characteristics. Higher quality
	encoder tries a lot of different tables and selects the one providing the best
	quality. The table is then included in the encoded file. Fast encoder includes
	entry selected from the above table and doesn't care about error analysis.
*/

/* ======================================================================================== */

/* ============================ LUTs for slower, HQ encoder =============================== */

const sineWindow = [
    0.006135884649, 0.018406729906, 0.030674803177, 0.042938256935, 0.055195244350, 0.067443919564, 0.079682437971, 0.091908956497, 
    0.104121633872, 0.116318630912, 0.128498110794, 0.140658239333, 0.152797185258, 0.164913120490, 0.177004220412, 0.189068664150, 
    0.201104634842, 0.213110319916, 0.225083911360, 0.237023605994, 0.248927605746, 0.260794117915, 0.272621355450, 0.284407537211, 
    0.296150888244, 0.307849640042, 0.319502030816, 0.331106305760, 0.342660717312, 0.354163525420, 0.365612997805, 0.377007410216, 
    0.388345046699, 0.399624199846, 0.410843171058, 0.422000270800, 0.433093818853, 0.444122144570, 0.455083587126, 0.465976495768, 
    0.476799230063, 0.487550160148, 0.498227666973, 0.508830142543, 0.519355990166, 0.529803624686, 0.540171472730, 0.550457972937, 
    0.560661576197, 0.570780745887, 0.580813958096, 0.590759701859, 0.600616479384, 0.610382806276, 0.620057211763, 0.629638238915, 
    0.639124444864, 0.648514401022, 0.657806693297, 0.666999922304, 0.676092703575, 0.685083667773, 0.693971460890, 0.702754744457, 
    0.711432195745, 0.720002507961, 0.728464390448, 0.736816568877, 0.745057785441, 0.753186799044, 0.761202385484, 0.769103337646, 
    0.776888465673, 0.784556597156, 0.792106577300, 0.799537269108, 0.806847553544, 0.814036329706, 0.821102514991, 0.828045045258, 
    0.834862874986, 0.841554977437, 0.848120344803, 0.854557988365, 0.860866938638, 0.867046245516, 0.873094978418, 0.879012226429, 
    0.884797098431, 0.890448723245, 0.895966249756, 0.901348847046, 0.906595704515, 0.911706032005, 0.916679059921, 0.921514039342, 
    0.926210242138, 0.930766961079, 0.935183509939, 0.939459223602, 0.943593458162, 0.947585591018, 0.951435020969, 0.955141168306, 
    0.958703474896, 0.962121404269, 0.965394441698, 0.968522094274, 0.971503890986, 0.974339382786, 0.977028142658, 0.979569765685, 
    0.981963869110, 0.984210092387, 0.986308097245, 0.988257567731, 0.990058210262, 0.991709753669, 0.993211949235, 0.994564570734, 
    0.995767414468, 0.996820299291, 0.997723066644, 0.998475580573, 0.999077727753, 0.999529417501, 0.999830581796, 0.999981175283, 
    0.999981175283, 0.999830581796, 0.999529417501, 0.999077727753, 0.998475580573, 0.997723066644, 0.996820299291, 0.995767414468, 
    0.994564570734, 0.993211949235, 0.991709753669, 0.990058210262, 0.988257567731, 0.986308097245, 0.984210092387, 0.981963869110, 
    0.979569765685, 0.977028142658, 0.974339382786, 0.971503890986, 0.968522094274, 0.965394441698, 0.962121404269, 0.958703474896, 
    0.955141168306, 0.951435020969, 0.947585591018, 0.943593458162, 0.939459223602, 0.935183509939, 0.930766961079, 0.926210242138, 
    0.921514039342, 0.916679059921, 0.911706032005, 0.906595704515, 0.901348847046, 0.895966249756, 0.890448723245, 0.884797098431, 
    0.879012226429, 0.873094978418, 0.867046245516, 0.860866938638, 0.854557988365, 0.848120344803, 0.841554977437, 0.834862874986, 
    0.828045045258, 0.821102514991, 0.814036329706, 0.806847553544, 0.799537269108, 0.792106577300, 0.784556597156, 0.776888465673, 
    0.769103337646, 0.761202385484, 0.753186799044, 0.745057785441, 0.736816568877, 0.728464390448, 0.720002507961, 0.711432195745, 
    0.702754744457, 0.693971460890, 0.685083667773, 0.676092703575, 0.666999922304, 0.657806693297, 0.648514401022, 0.639124444864, 
    0.629638238915, 0.620057211763, 0.610382806276, 0.600616479384, 0.590759701859, 0.580813958096, 0.570780745887, 0.560661576197, 
    0.550457972937, 0.540171472730, 0.529803624686, 0.519355990166, 0.508830142543, 0.498227666973, 0.487550160148, 0.476799230063, 
    0.465976495768, 0.455083587126, 0.444122144570, 0.433093818853, 0.422000270800, 0.410843171058, 0.399624199846, 0.388345046699, 
    0.377007410216, 0.365612997805, 0.354163525420, 0.342660717312, 0.331106305760, 0.319502030816, 0.307849640042, 0.296150888244, 
    0.284407537211, 0.272621355450, 0.260794117915, 0.248927605746, 0.237023605994, 0.225083911360, 0.213110319916, 0.201104634842, 
    0.189068664150, 0.177004220412, 0.164913120490, 0.152797185258, 0.140658239333, 0.128498110794, 0.116318630912, 0.104121633872, 
    0.091908956497, 0.079682437971, 0.067443919564, 0.055195244350, 0.042938256935, 0.030674803177, 0.018406729906, 0.006135884649
];

const twiddleReal = [
    1.000000000000, 0.995184726672, 0.980785280403, 0.956940335732, 0.923879532511, 0.881921264348, 0.831469612303, 0.773010453363, 
    0.707106781187, 0.634393284164, 0.555570233020, 0.471396736826, 0.382683432365, 0.290284677254, 0.195090322016, 0.098017140330, 
    0.000000000000, -0.098017140330, -0.195090322016, -0.290284677254, -0.382683432365, -0.471396736826, -0.555570233020, -0.634393284164, 
    -0.707106781187, -0.773010453363, -0.831469612303, -0.881921264348, -0.923879532511, -0.956940335732, -0.980785280403, -0.995184726672
];

const twiddleImag = [
    0.000000000000, -0.098017140330, -0.195090322016, -0.290284677254, -0.382683432365, -0.471396736826, -0.555570233020, -0.634393284164, 
    -0.707106781187, -0.773010453363, -0.831469612303, -0.881921264348, -0.923879532511, -0.956940335732, -0.980785280403, -0.995184726672, 
    -1.000000000000, -0.995184726672, -0.980785280403, -0.956940335732, -0.923879532511, -0.881921264348, -0.831469612303, -0.773010453363, 
    -0.707106781187, -0.634393284164, -0.555570233020, -0.471396736826, -0.382683432365, -0.290284677254, -0.195090322016, -0.098017140330
];

const sines = [
    0.001084686516, 0.009760953548, 0.018431340947, 0.027090625996, 0.035733592664, 0.044355034752, 0.052949759026, 0.061512588345, 
    0.070038364780, 0.078521952724, 0.086958241980, 0.095342150842, 0.103668629157, 0.111932661367, 0.120129269527, 0.128253516307, 
    0.136300507965, 0.144265397293, 0.152143386540, 0.159929730300, 0.167619738371, 0.175208778579, 0.182692279570, 0.190065733563, 
    0.197324699066, 0.204464803548, 0.211481746078, 0.218371299912, 0.225129315041, 0.231751720688, 0.238234527764, 0.244573831269, 
    0.250765812643, 0.256806742069, 0.262692980715, 0.268420982933, 0.273987298387, 0.279388574138, 0.284621556659, 0.289683093797, 
    0.294570136672, 0.299279741510, 0.303809071423, 0.308155398112, 0.312316103511, 0.316288681368, 0.320070738750, 0.323659997487, 
    0.327054295544, 0.330251588323, 0.333249949894, 0.336047574157, 0.338642775926, 0.341033991949, 0.343219781848, 0.345198828984, 
    0.346969941254, 0.348532051805, 0.349884219680, 0.351025630384, 0.351955596375, 0.352673557474, 0.353179081210, 0.353471863073
];

const cosines = [
    0.353551726704, 0.353418623994, 0.353072635120, 0.352513968494, 0.351742960634, 0.350760075967, 0.349565906546, 0.348161171694, 
    0.346546717570, 0.344723516663, 0.342692667199, 0.340455392486, 0.338013040175, 0.335367081448, 0.332519110132, 0.329470841737, 
    0.326224112427, 0.322780877909, 0.319143212261, 0.315313306675, 0.311293468143, 0.307086118066, 0.302693790794, 0.298119132102, 
    0.293364897591, 0.288433951036, 0.283329262653, 0.278053907318, 0.272611062705, 0.267004007382, 0.261236118829, 0.255310871407, 
    0.249231834262, 0.243002669179, 0.236627128375, 0.230109052237, 0.223452367010, 0.216661082433, 0.209739289321, 0.202691157104, 
    0.195520931313, 0.188232931023, 0.180831546255, 0.173321235325, 0.165706522164, 0.157991993590, 0.150182296547, 0.142282135304, 
    0.134296268622, 0.126229506891, 0.118086709224, 0.109872780540, 0.101592668600, 0.093251361036, 0.084853882339, 0.076405290837, 
    0.067910675643, 0.059375153599, 0.050803866182, 0.042201976415, 0.033574665756, 0.024927130974, 0.016264581020, 0.007592233891
];

const mirrored = [
    0, 32, 16, 48, 8, 40, 24, 56, 4, 36, 20, 52, 12, 44, 28, 60, 2, 34, 18, 50, 10, 42, 26, 58, 6, 38, 22, 54, 14, 46, 30, 62, 
    1, 33, 17, 49, 9, 41, 25, 57, 5, 37, 21, 53, 13, 45, 29, 61, 3, 35, 19, 51, 11, 43, 27, 59, 7, 39, 23, 55, 15, 47, 31, 63
];

const thresholds = [
    35.000, 29.373, 20.644, 13.596, 10.495, 8.794, 7.646, 6.767, 6.073, 5.559, 5.120, 4.738, 4.423, 4.142, 3.882, 3.652, 
    3.435, 3.227, 3.030, 2.841, 2.657, 2.473, 2.288, 2.102, 1.915, 1.720, 1.518, 1.314, 1.097, 0.870, 0.634, 0.392, 
    0.141, -0.128, -0.404, -0.687, -0.977, -1.275, -1.580, -1.889, -2.200, -2.514, -2.819, -3.116, -3.404, -3.678, -3.933, -4.168, 
    -4.380, -4.557, -4.706, -4.827, -4.918, -4.965, -4.977, -4.952, -4.893, -4.808, -4.684, -4.528, -4.346, -4.142, -3.912, -3.665, 
    -3.407, -3.140, -2.862, -2.580, -2.297, -2.016, -1.748, -1.480, -1.221, -0.973, -0.725, -0.501, -0.289, -0.077, 0.105, 0.282, 
    0.459, 0.604, 0.747, 0.890, 1.002, 1.115, 1.227, 1.318, 1.409, 1.500, 1.575, 1.648, 1.721, 1.784, 1.842, 1.901, 
    1.958, 2.012, 2.067, 2.120, 2.171, 2.221, 2.271, 2.320, 2.370, 2.419, 2.468, 2.519, 2.570, 2.621, 2.673, 2.726, 
    2.778, 2.832, 2.889, 2.946, 3.003, 3.060, 3.119, 3.177, 3.236, 3.297, 3.359, 3.422, 3.484, 3.548, 3.612, 3.676, 
    3.741, 3.811, 3.882, 3.952, 4.023, 4.096, 4.170, 4.243, 4.317, 4.395, 4.473, 4.550, 4.628, 4.709, 4.791, 4.872, 
    4.954, 5.039, 5.126, 5.212, 5.299, 5.388, 5.481, 5.574, 5.666, 5.759, 5.851, 5.944, 6.037, 6.129, 6.230, 6.333, 
    6.437, 6.540, 6.643, 6.746, 6.850, 6.953, 7.056, 7.168, 7.281, 7.395, 7.508, 7.621, 7.735, 7.848, 7.961, 8.075, 
    8.196, 8.321, 8.445, 8.569, 8.693, 8.818, 8.942, 9.066, 9.190, 9.321, 9.458, 9.595, 9.733, 9.870, 10.007, 10.144, 
    10.281, 10.418, 10.557, 10.707, 10.858, 11.009, 11.159, 11.310, 11.461, 11.611, 11.762, 11.913, 12.071, 12.235, 12.399, 12.563, 
    12.727, 12.891, 13.055, 13.219, 13.383, 13.547, 13.724, 13.902, 14.080, 14.258, 14.436, 14.614, 14.792, 14.970, 15.148, 15.328, 
    15.524, 15.720, 15.916, 16.111, 16.307, 16.503, 16.699, 16.894, 17.090, 17.291, 17.504, 17.717, 17.929, 18.142, 18.355, 18.568, 
    18.781, 18.994, 19.207, 19.427, 19.659, 19.890, 20.122, 20.354, 20.585, 20.817, 21.049, 21.280, 21.512, 21.752, 22.002, 22.253, 
    22.503, 22.753, 23.004, 23.254, 23.505, 23.755, 24.006, 24.266, 24.538, 24.811, 25.084, 25.357, 25.630, 25.903, 26.176, 26.449, 
    26.722, 27.003, 27.295, 27.587, 27.879, 28.171, 28.463, 28.755, 29.047, 29.339, 29.631, 29.930, 30.247, 30.564, 30.881, 31.197, 
    31.514, 31.831, 32.148, 32.465, 32.781, 33.103, 33.446, 33.789, 34.131, 34.474, 34.817, 35.160, 35.503, 35.845, 36.188, 36.533, 
    36.902, 37.272, 37.642, 38.012, 38.381, 38.751, 39.121, 39.491, 39.860, 40.230, 40.626, 41.023, 41.420, 41.817, 42.213, 42.610, 
    43.007, 43.404, 43.800, 44.197, 44.624, 45.058, 45.491, 45.924, 46.357, 46.790, 47.223, 47.656, 48.089, 48.522, 50.000, 55.000
];

/* ======================================================================================== */

class BitStream {  // bitstream reader / writer
    constructor(initData) {
        this.buffer = initData ? new Uint8Array(initData) : new Uint8Array(1024);
        this.bufferedByte = 0;
        this.byteAt = 0;
        this.bitAt = 0;
        this.length = initData ? initData.length : 0;
    }
    _expandBuffer() {
        const newBuffer = new Uint8Array(this.buffer.length * 2);
        newBuffer.set(this.buffer);
        this.buffer = newBuffer;
    }
    write(value, size) {
        let mask = (1 << (size - 1)) >>> 0;
        for(let i=0; i < size; i++) {
            this.bufferedByte <<= 1;
            if(value & mask) {
                this.bufferedByte |= 1;
            }
            mask >>>= 1;
            this.bitAt++;
            if(this.bitAt == 8) {
                if(this.length >= this.buffer.length) {
                    this._expandBuffer();
                }
                this.buffer[this.length] = this.bufferedByte;
                this.length++;
                this.bufferedByte = 0;
                this.bitAt = 0;
            }
        }
    }
    read(size) {
        let value = 0;
        let mask = 1 << (this.bitAt - 1);
        for(let i=0; i < size; i++) {
            if(this.bitAt == 0) {
                if(this.byteAt >= this.length) {
                    return 0;
                }
                this.bufferedByte = this.buffer[this.byteAt];
                this.byteAt++;
                this.bitAt = 8;
                mask = 128;
            }
            value <<= 1;
            if(this.bufferedByte & mask) {
                value |= 1;
            }
            mask >>= 1;
            this.bitAt--;
        }
        return value;
    }
    seek(bitPos) {
        this.byteAt = bitPos >> 3;
        this.bitAt = (8 - (bitPos & 7)) & 7;
    }
    writeLast() {
        if(this.bitAt > 0) {
            if(this.length >= this.buffer.length) {
                this._expandBuffer();
            }
            this.buffer[this.length] = this.bufferedByte << (8 - this.bitAt);
            this.length++;
            this.bufferedByte = 0;
            this.bitAt = 0;
        }
    }
    get bytes() {
        return this.buffer.subarray(0, this.length);
    }
}

/* ================================= Fast 8-bit encoder =================================== */

function fac_encode_FAST(stream, audio, offset, slice_len, slices) {
	const channels = audio.channels;
	const channelData = audio.channelData;
	const BPS = audio.bitsPerSample;
	stream.write(0x46, 8); // 'F' frame mark

	const reference = new Int16Array(channels);
	for(let c=0; c<channels; c++) {
		const sample = channelData[c][offset];
		reference[c] = sample;
		stream.write(sample, 16);
	}
	
	const dequant_table = dequant_tab_fast[BPS - 1];   // dequantization table
	const indexes = 1 << BPS;
	for(let s=0; s<slices; s++) {
		for(let c=0; c<channels; c++) {
			const samples = channelData[c];
			let maxDiff = 0;
			let prev = reference[c];
			for(let i=0; i<slice_len; i++) {
				const current = samples[offset + i];
				const diff = current - prev;
				let absDiff = diff < 0 ? -diff : diff;
				prev = current;
				if(absDiff > maxDiff) {
					maxDiff = absDiff;
				}
			}
			let predicted = reference[c];
			if(BPS > 1) {
				let scalefactor = maxDiff >> 3;
				if(scalefactor > 15){scalefactor = 15;}
				stream.write(scalefactor, 4);
				const dequant_table_entry = dequant_table[scalefactor];
				const inverse = inverse_tab_fast[scalefactor];
				for(let i=0; i<slice_len; i++) {
					const sample = samples[offset + i];
					const residual = sample - predicted;
					let scaled = (residual * inverse + 64) >> 7;
					if(scaled > 8){scaled = 8;}
					else if(scaled < -8){scaled = -8;}
					let quantized = quant_tab_fast[BPS - 2][scaled + 8];
					let reconstructed;
					if(scaled < 0) { // catch overflows here so that decoder will be branchless
						for(let j=quantized; j<indexes; j++) {
							reconstructed = predicted + dequant_table_entry[j];
							if(reconstructed < -128) {
								continue;
							}
							quantized = j;
							break;
						}
					}
					else {
						for(let j=quantized; j>=0; j--) {
							reconstructed = predicted + dequant_table_entry[j];
							if(reconstructed > 127) {
								continue;
							}
							quantized = j;
							break;
						}
					}
					predicted = reconstructed;
					stream.write(quantized, BPS);
				}
			}
			else {
				let scalefactor = (maxDiff * 6 + 18) >> 5; // values chosen by hand & ears
				if(scalefactor > 15){scalefactor = 15;}
				stream.write(scalefactor, 4);
				const dequant_table_entry = dequant_table[scalefactor];
				for(let i=0; i<slice_len; i++) {
					const sample = samples[offset + i];
					const residual = sample - predicted;
					let quantized = (residual < 0) ? 0 : 1;
					let test = predicted + dequant_table_entry[quantized];
					if(test < -128 || test > 127) {
						quantized = 1 - quantized;
					}
					predicted += dequant_table_entry[quantized];
					stream.write(quantized, BPS);
				}
			}
			reference[c] = predicted;
		}
		offset += slice_len;
	}
}

/* ======================================================================================== */

/* ================================= Slower, HQ encoder =================================== */

function get_sweep_ranges(bitDepth) {
	const range = 1 << bitDepth;
	const defaults = [
		1,
		1 + bitDepth / 8,
		1,
		Math.pow(range, 0.6),
		1 + bitDepth / 8,
		Math.pow(range, 0.35),
		range * 0.375,
		1 + bitDepth / 8,
		Math.round(8 - bitDepth * 0.4)
	];
	const lower_lim = [
		-1,
		-1,
		1,
		Math.pow(range, 0.35),
		0.5 + bitDepth * 0.09375,
		1,
		range / 16,
		0.5,
		0
	];
	const upper_lim = [
		4 + bitDepth / 8,
		4 + bitDepth / 4,
		Math.pow(range, 0.1875),
		Math.pow(range, 0.75),
		4 + bitDepth / 8,
		Math.pow(range, 0.5),
		range / 2,
		5 + bitDepth / 8,
		10 - bitDepth / 2
	];
	return {defaults, lower_lim, upper_lim};
}

function Bark(f) {
	let result = (26.81 * f) / (1960 + f) - 0.53;
	return result < 0 ? 0 : result;
}

function coeffToBark(coeff, rate) {
	let frq = ((coeff + 1) / 256) * rate;
	let result = Bark(frq);
	return result > 26 ? 26 : result;
}

function get_mult_curve(sampleRate) {
	let prev = 0;
	let importance = [];
	let maxDiff = 0;
	for(let i=0; i<128; i++) {
		let current = coeffToBark(i, sampleRate);
		let diff = current - prev;
		if(diff > maxDiff) {
			maxDiff = diff;
		}
		importance.push(diff);
		prev = current;
	}
	const normalize = 1 / maxDiff;
	let topHit = false;
	for(let i=0; i<128; i++) {
		if(!topHit) {
			if(importance[i] > 0.999 * maxDiff) {
				topHit = true;
			}
			importance[i] = 1;
			continue;
		}
		importance[i] *= normalize;
	}
	return importance;
}

function coeffToFreq(coeff, rate) {
	return (coeff + 1) / 256 * rate;
}

function hearingThreshold(coeff, rate) {
	let find = coeffToFreq(coeff, rate);
	if(find < 50) {
		return thresholds[0];
	}
	let ind = Math.round((find - 50) / 60 + 1);
	return ind > 335 ? 120 : thresholds[ind];
}

function dBconvert(coeffs, dynamicRange) {
	let absVal = new Array(128);
	for(let i=0; i<128; i++) {
		absVal[i] = Math.abs(coeffs[i]);
	}
	const top = Math.max.apply(Math, absVal);
	if(top < 0.001) {
		return absVal.fill(-120);
	}
	let result = new Array(128);
	for(let i=0; i<128; i++) {
		let magnitude = absVal[i] == 0 ? 0.001 : absVal[i];
		let dB = 20 * Math.log10(magnitude / top);
		if(dB < -120) {
			dB = -120;
		}
		result[i] = dB + dynamicRange;
	}
	return result;
}


function FMDCT(raw_samples) {
	let data = new Array(256);
    let real = new Array(64);
	let imag = new Array(64);
	let result = new Array(128);
	let at = 0;
	for(let i=0; i<256; i++) {
		data[i] = raw_samples[i] * sineWindow[i];
	}
	for(let i=0; i<64; i+=2) {
		let r0 = data[191 - i] + data[192 + i];
		let i0 = data[64 + i] - data[63 - i];
		let c = cosines[at];
		let s = sines[at];
		let mirrorIndex = mirrored[at++];
		real[mirrorIndex] = r0 * c + i0 * s;
		imag[mirrorIndex] = i0 * c - r0 * s;
	}
	for(let i=64; i<128; i+=2) {
		let r0 = data[191 - i] - data[i - 64];
		let i0 = data[64 + i] + data[319 - i];
		let c = cosines[at];
		let s = sines[at];
		let mirrorIndex = mirrored[at++];
		real[mirrorIndex] = r0 * c + i0 * s;
		imag[mirrorIndex] = i0 * c - r0 * s;
	}
	let inc = 64;
	let step = 1;
	let width;
	for(let stage=0; stage<6; stage++) {
		let twiddleAt = 0;
		inc >>= 1;
		width = step;
		step <<= 1;
		for(let i=0; i<width; i++) {
			let WnReal = twiddleReal[twiddleAt];
			let WnImag = twiddleImag[twiddleAt];
			twiddleAt += inc;
			for(let j=i; j<64; j+=step) {
				let offset = j + width;
				let topReal = real[j];
				let topImag = imag[j];
				let bottomReal = real[offset];
				let bottomImag = imag[offset];
				let tmpReal;
				let tmpImag;
				if(i) {
					tmpReal = (bottomReal * WnReal) - (bottomImag * WnImag);
					tmpImag = (bottomReal * WnImag) + (bottomImag * WnReal);
				}
				else {
					tmpReal = bottomReal;
					tmpImag = bottomImag;
				}
				real[offset] = topReal - tmpReal;
				imag[offset] = topImag - tmpImag;
				real[j] = topReal + tmpReal;
				imag[j] = topImag + tmpImag;
			}
		}
	}
	at = 0;
	for(let i=0; i<128; i+=2) {
		let r0 = real[at];
		let i0 = imag[at];
		let c = cosines[at];
		let s = sines[at++];
		result[i] = -r0 * c - i0 * s;
		result[127 - i] = -r0 * s + i0 * c;
	}
	return result;
}

function get_range(bit_width) {
	const half = 1 << (bit_width - 1);
	return [-half, half - 1];
}

// parameters order in curves[]: c, ce, lb, le, lc, ub, ue, uc

function dequant_lookup(precision, bitDepth, curves) {
	let result = [];
	const entry_size = 1 << (precision - 1);
	const array_size = entry_size * 2;
	const range = get_range(bitDepth);
	let lower_c = curves[4];
	let upper_c = curves[7];
	if(lower_c > -0.01 && lower_c < 0.01){lower_c = 0.01;}
	if(upper_c > -0.01 && upper_c < 0.01){upper_c = 0.01;}
	let down_bound = get_curve(16, curves[2], curves[3], lower_c);
	let up_bound = get_curve(16, curves[5], curves[6], upper_c);
	let c = curves[0];
	const c_dir = (curves[1] - c) / 15;
	for(let i=0; i<16; i++) {
		if(c > -0.01 && c < 0.01) {
			c_dir > 0 ? c = 0.01 : c = -0.01;
		}
		let single = new Array(array_size);
		let adjusted = 0;
		do {
			let raw_curve = get_curve(entry_size, down_bound[i], up_bound[i], c);
			let prev = 0;
			for(let j=0; j<entry_size; j++) {
				let point = Math.round(raw_curve[j]);
				while(point <= prev){point++};
				prev = point;
				single[entry_size + j] = point <= range[1] ? point : range[1];
				single[entry_size - j - 1] = -point >= range[0] ? -point : range[0];
			}
			if(i < curves[8] && precision > 1) {
				let last = Math.round((single[array_size - 2] + single[array_size - 1]) / 2);
				single[array_size - 1] = last;
				for(let j=array_size-2; j>entry_size; j--) {
					single[j] = single[j - 1];
				}
				single[entry_size] = 0;
			}
			up_bound[i] += 1;
		} while(included(single, result) && ++adjusted < 100);
		result.push(single);
		c += c_dir;
	}
	return result;
}

function are_equal(arr1, arr2) {
	if(arr1.length != arr2.length){return false;}
	for(let i=0; i<arr1.length; i++) {
		if(arr1[i] != arr2[i]){return false;}
	}
	return true;
}

function included(entry, search_in) {
	for(let i=0; i<search_in.length; i++) {
		if(are_equal(entry, search_in[i])){return true;}
	}
	return false;
}

function get_curve(n, a, b, c) { // n = points, a = start, b = end, c = curvature
	if(n < 2){return [(a + 2 * b) / 3];}
	if(n == 2){return [a, b];}
	let result = [];
	for(let x=1; x<=n; x++) {
		let y = (a * Math.pow(n, c) - b + (b - a) * Math.pow(x, c)) / (Math.pow(n, c) - 1);
		result.push(y);
	}
	return result;
}


function frame_error(original, decoded, weight_curve, sampleRate) {
	let timeOrigMag = 0.5;
	let timeDecMag = 0.5;
	for(let i=0; i<256; i++) {
		const origSample = Math.abs(original[i]);
		const decSample = Math.abs(decoded[i]);
		if(origSample > timeOrigMag) {
			timeOrigMag = origSample;
		}
		if(decSample > timeDecMag) {
			timeDecMag = decSample;
		}
	}
	const rangeOrig = Math.log10(timeOrigMag * 2) * 20;
	const rangeDec = Math.log10(timeDecMag * 2) * 20;
	const origSpectrum = dBconvert(FMDCT(original), rangeOrig);
	const decSpectrum = dBconvert(FMDCT(decoded), rangeDec);
	let errorSum = 0;
	for(let i=0; i<128; i++) {
		const thresh = hearingThreshold(i, sampleRate);
		const importance = weight_curve[i];
		let origMag = origSpectrum[i] - thresh;
		let decMag = decSpectrum[i] - thresh;
		if(origMag <= 0 && decMag <= 0){continue;}
		if(origMag < 0){origMag = 0;}
		if(decMag < 0){decMag = 0;}
		errorSum += Math.abs(decMag - origMag) * importance;
	}
	return errorSum;
}

function num_error(original, decoded) {
	let origAvg = 0;
	for(let i=0; i<256; i++) {
		origAvg += Math.abs(original[i]);
	}
	origAvg = Math.max(origAvg / 256, 8);
	let errSum = 0;
	for(let i=0; i<256; i++) {
		const err = decoded[i] - original[i];
		errSum += err * err;
	}
	return errSum / origAvg;
}

function encoding_error(audio, slice_len, dequant_table, weights) {
	const channels = audio.channels;
	const BPS = audio.bitsPerSample;
	const bitDepth = audio.bitDepth;
	const channelData = audio.channelData;
	const sampleRate = audio.sampleRate;
	const audioLen = channelData[0].length;
	const jump_by = Math.round(0.25 * sampleRate);
	const table_size = 1 << BPS;
	const start_pos = table_size / 2;
	const start_neg = start_pos - 1;
	const range = get_range(bitDepth);
	let offset = 0;
	let totalError = 0;
	let processed = 0;
	let selChannel = 0;
	let original = new Array(256);
	let decoded = new Array(256);
	let loaded = 0;
	while(offset + slice_len <= audioLen) {
		const samples = channelData[selChannel];
		let reference = samples[offset];
		let best_slice;
		let lowest = Infinity;
		for(let tested=0; tested<16; tested++) {
			const dequant_entry = dequant_table[tested];
			let predicted = reference;
			let aborted = false;
			let slice = [];
			let errSum = 0;
			if(BPS == 1) {
				for(let i=0; i<slice_len; i++) {
					const sample = samples[offset + i];
					const residual = sample - predicted;
					let ind = residual < 0 ? 0 : 1;
					const test = predicted + dequant_entry[ind];
					if(test < range[0] || test > range[1]) {
						ind = 1 - ind;
					}
					predicted += dequant_entry[ind];
					slice.push(predicted);
					let err = sample - predicted;
					errSum += err * err;
					if(errSum >= lowest) {
						aborted = true;
						break;
					}
				}
			}
			else {
				for(let i=0; i<slice_len; i++) {
					const sample = samples[offset + i];
					const residual = sample - predicted;
					if(residual < 0) {
						let selected = 0;
						for(let ind=start_neg; ind>0; ind--) {
							if(dequant_entry[ind] <= residual) {
								selected = ind;
								break;
							}
						}
						const err1 = Math.abs(dequant_entry[selected] - residual);
						const err2 = Math.abs(dequant_entry[selected + 1] - residual);
						const test = predicted + dequant_entry[selected];
						if(err2 < err1 || test < range[0]) {
							errSum += err2 * err2;
							predicted += dequant_entry[selected + 1];
						}
						else {
							errSum += err1 * err1;
							predicted += dequant_entry[selected];
						}
						if(errSum >= lowest) {
							aborted = true;
							break;
						}
					}
					else {
						let selected = table_size - 1;
						for(let ind=start_pos; ind<table_size-1; ind++) {
							if(dequant_entry[ind] >= residual) {
								selected = ind;
								break;
							}
						}
						const err1 = Math.abs(dequant_entry[selected] - residual);
						const err2 = Math.abs(dequant_entry[selected - 1] - residual);
						const test = predicted + dequant_entry[selected];
						if(err2 < err1 || test > range[1]) {
							errSum += err2 * err2;
							predicted += dequant_entry[selected - 1];
						}
						else {
							errSum += err1 * err1;
							predicted += dequant_entry[selected];
						}
						if(errSum >= lowest) {
							aborted = true;
							break;
						}
					}
					slice.push(predicted);
				}
			}
			if(!aborted) {
				lowest = errSum;
				best_slice = slice;
			}
		}
		for(let i=0; i<slice_len; i++) {
			original[loaded] = samples[offset++];
			decoded[loaded++] = best_slice[i];
			if(loaded == 256) {
				totalError += frame_error(original, decoded, weights, sampleRate);
				loaded = 0;
				processed += 256;
				selChannel++;
				if(selChannel >= channels) {
					selChannel = 0;
					offset += jump_by;
				}
				break;
			}
		}
	}
	totalError /= processed;
	return totalError;
}


function fac_encode_HQ(stream, audio, offset, slices, slice_len, dequant_table) {
	const channels = audio.channels;
	const channelData = audio.channelData;
	const BPS = audio.bitsPerSample;
	const bitDepth = audio.bitDepth;
	const table_size = 1 << BPS;
	const start_pos = table_size / 2;
	const start_neg = start_pos - 1;
	const range = get_range(bitDepth);
	stream.write(0x46, 8); // 'F' frame mark
	const reference = new Int16Array(channels);
	// write first samples
	for(let c=0; c<channels; c++) {
		const sample = channelData[c][offset];
		reference[c] = sample;
		stream.write(sample, 16);
	}
	for(let s=0; s<slices; s++) {
		for(let c=0; c<channels; c++) {
			const samples = channelData[c];
			let selected_entry;
			let reference_sample;
			let lowest = Infinity;
			let quantized_slice = [];
			for(let tested=0; tested<16; tested++) {
				const dequant_entry = dequant_table[tested];
				let slice = [];
				let predicted = reference[c];
				let aborted = false;
				let errSum = 0;
				if(BPS == 1) {
					for(let i=0; i<slice_len; i++) {
						const sample = samples[offset + i];
						const residual = sample - predicted;
						let ind = residual < 0 ? 0 : 1;
						const test = predicted + dequant_entry[ind];
						if(test < range[0] || test > range[1]) {
							ind = 1 - ind;
						}
						predicted += dequant_entry[ind];
						slice.push(ind);
						let err = sample - predicted;
						errSum += err * err;
						if(errSum >= lowest) {
							aborted = true;
							break;
						}
					}
				}
				else {
					for(let i=0; i<slice_len; i++) {
						const sample = samples[offset + i];
						const residual = sample - predicted;
						if(residual < 0) {
							let selected = 0;
							for(let ind=start_neg; ind>0; ind--) {
								if(dequant_entry[ind] <= residual) {
									selected = ind;
									break;
								}
							}
							const err1 = Math.abs(dequant_entry[selected] - residual);
							const err2 = Math.abs(dequant_entry[selected + 1] - residual);
							const test = predicted + dequant_entry[selected];
							if(err2 < err1 || test < range[0]) {
								errSum += err2 * err2;
								selected++;
							}
							else {
								errSum += err1 * err1;
							}
							predicted += dequant_entry[selected];
							slice.push(selected);
							if(errSum >= lowest) {
								aborted = true;
								break;
							}
						}
						else {
							let selected = table_size - 1;
							for(let ind=start_pos; ind<table_size-1; ind++) {
								if(dequant_entry[ind] >= residual) {
									selected = ind;
									break;
								}
							}
							const err1 = Math.abs(dequant_entry[selected] - residual);
							const err2 = Math.abs(dequant_entry[selected - 1] - residual);
							const test = predicted + dequant_entry[selected];
							if(err2 < err1 || test > range[1]) {
								errSum += err2 * err2;
								selected--;
							}
							else {
								errSum += err1 * err1;
							}
							slice.push(selected);
							predicted += dequant_entry[selected];
							if(errSum >= lowest) {
								aborted = true;
								break;
							}
						}
					}
				}
				if(!aborted) {
					lowest = errSum;
					selected_entry = tested;
					quantized_slice = slice;
					reference_sample = predicted;
				}
			}
			reference[c] = reference_sample;
			stream.write(selected_entry, 4);
			for(let i=0; i<slice_len; i++) {
				stream.write(quantized_slice[i], BPS);
			}
		}
		offset += slice_len;
	}
}

function next_solution(best_sol, lim_l, lim_u, temperature) {
	let new_sol = [];
	const rand_range = temperature / 100;
	for(let i=0; i<best_sol.length; i++) {
		const range = (lim_u[i] - lim_l[i]) * rand_range;
		let new_val = best_sol[i] + range * (Math.random() * 2 - 1);
		new_val = Math.min(Math.max(new_val, lim_l[i]), lim_u[i]);
		new_sol.push(new_val);
	}
	return new_sol;
}

function fac_analyze_and_encode(stream, audio, quality_grade, slice_len, frame_slices, last_fr_slices, reg_frames) {
	const bitsPerSample = audio.bitsPerSample;
	const bitDepth = audio.bitDepth;
	const sampleRate = audio.sampleRate;
	const ranges = get_sweep_ranges(bitDepth);
	const defaults = ranges.defaults;
	const lower_lim = ranges.lower_lim;
	const upper_lim = ranges.upper_lim;
	const weights = get_mult_curve(sampleRate);
	let default_table = dequant_lookup(bitsPerSample, bitDepth, defaults);
	let lowest = encoding_error(audio, slice_len, default_table, weights);
	let best_table = default_table;
	let progress = [lowest];
	let best_err = lowest;
	let best_sol = [...defaults];
	if(quality_grade > 1) { // don't search for best table with quality_grade == 1
		let temperature = 100;
		const points = Math.round(8.926179 * Math.pow(quality_grade, 2.163885));
		const cooling = Math.pow(0.2 / temperature, 1 / (points - 20));
		console.log("Tables to test:", points);
		let temperatures = [];
		let percentBef = 1;
		for(let i=0; i<points; i++) {
			let tested_sol = next_solution(best_sol, lower_lim, upper_lim, temperature);
			tested_sol[8] = Math.round(tested_sol[8]); // this has to be an integer
			let table = dequant_lookup(bitsPerSample, bitDepth, tested_sol);
			let new_err = encoding_error(audio, slice_len, table, weights);
			progress.push(new_err);
			if(new_err < best_err) {
				best_err = new_err;
				best_sol = tested_sol;
				best_table = table;
			}
			temperatures.push(temperature);
			if(i > 18) {
				temperature *= cooling;
			}
			let percent = Math.round(i / points * 10);
			if(percent != percentBef) {
				percentBef = percent;
				console.log(percent * 10 + "%");
			}
		}
	}
    console.log("Selected lookup table:");
	console.log(best_table);
	const cell_size = 1 << bitsPerSample;
	for(let i=0; i<16; i++) {
		for(let j=0; j<cell_size; j++) {
			stream.write(best_table[i][j], 16);
		}
	}
	const frame_len = frame_slices * slice_len;
	stream.write(0x64617461, 32); // "data"
	let offset = 0;
	for(let f=0; f<reg_frames; f++) {
		fac_encode_HQ(stream, audio, offset, frame_slices, slice_len, best_table);
		offset += frame_len;
	}
	if(last_fr_slices) {
		fac_encode_HQ(stream, audio, offset, last_fr_slices, slice_len, best_table);
	}
}

/* ======================================================================================== */

/* ====================================== Decoder ========================================= */

function decode_header(stream) {
	const magic = stream.read(32);
	if(magic !== 0x6661635F) { // fac_
		throw new Error("Not a FAC file; expected magic number \'fac_\'");
	}
	const playback_data = {
		channels: stream.read(8),
		samples: stream.read(32),
		sampleRate: stream.read(24),
		bitsPerSample: stream.read(8),
		bitDepth: stream.read(8),
		channelData: []
    };
	const config_data = {
		reg_frames: stream.read(24),
		reg_frame_slices: stream.read(16),
		last_fr_slices: stream.read(16),
		slice_len: stream.read(8)
	};
	stream.read(32); // dummy field reserved for future use
	return {playback_data, config_data};
}

function fac_decode_frame(stream, audio, offset, slices, slice_len, dequant_table) {
	
	if(stream.read(8) != 0x46) { // 'F' frame mark expected
		throw new Error("Invalid frame header.");
	}
	const channels = audio.channels;
	const BPS = audio.bitsPerSample;
	const channelData = audio.channelData;
	const reference = new Int16Array(channels);
	for(let c=0; c<channels; c++) {
		reference[c] = stream.read(16);
	}
	for(let s=0; s<slices; s++) {
		for(let c=0; c<channels; c++) {
			const samples = channelData[c];
			const scalefactor = stream.read(4);
			let predicted = reference[c];
			const dequant_table_entry = dequant_table[scalefactor];
			for(let i=0; i<slice_len; i++) {
				const quantized = stream.read(BPS);
				predicted += dequant_table_entry[quantized];
				samples[offset + i] = predicted;
			}
			reference[c] = predicted;
		}
		offset += slice_len;
	}
}

/* ======================================================================================== */

/* ==================================== Main functions ==================================== */

function fac_encode({channelData, sampleRate = 44100, bitDepth = 8, bitsPerSample = 3, slice_len = 24, frame_slices = 2048, quality = 0} = {}) {  // encoding function
	const channels = channelData.length;
	const samples = channels >= 1 ? channelData[0].length : 0;
	const audio = {channels, channelData, bitsPerSample, sampleRate, bitDepth};
	
    quality = Math.round(Math.max(0, quality));
    if(quality > 10) {
        console.warn("Excessive quality setting, limiting to 10.");
        quality = 10;
    }
    
    if(samples < slice_len) {
		throw new Error("Too short audio.");
	}
	if(bitsPerSample < 1 || bitsPerSample > 4) {
		throw new Error("Bits per sample out of range [1 - 4].");
	}
	if(bitDepth < 4 || bitDepth > 16) {
		throw new Error("Bit depth out of range [4 - 16].");
	}
    if(quality == 0 && bitDepth != 8) {
		throw new Error("Only 8-bit audio can be encoded in fast mode.");
	}
    
	const frame_len = frame_slices * slice_len;
	const reg_frames = Math.floor(samples / frame_len);
	const samples_left = samples - reg_frames * frame_len;
	const last_fr_slices = Math.floor(samples_left / slice_len);
	const actual_samples = reg_frames * frame_len + last_fr_slices * slice_len;
	
	// write header
	const stream = new BitStream();
	stream.write(0x6661635F, 32);
	stream.write(channels, 8);
	stream.write(actual_samples, 32);
	stream.write(sampleRate, 24);
	stream.write(bitsPerSample, 8);
	stream.write(bitDepth, 8); // audio bit depth
	stream.write(reg_frames, 24); // frames with regular size
	stream.write(frame_slices, 16); // regular frame size
	stream.write(last_fr_slices, 16); // last frame size, might be smaller than regular
	stream.write(slice_len, 8); // slice length
	stream.write(0, 32); // reserved for future use
	
	const cell_size = 1 << bitsPerSample;
	let offset = 0;
	if(quality > 0) {
		fac_analyze_and_encode(stream, audio, quality, slice_len, frame_slices, last_fr_slices, reg_frames);
	}
	else {
		const dequant_table = dequant_tab_fast[bitsPerSample - 1];
		for(let i=0; i<16; i++) {
			for(let j=0; j<cell_size; j++) {
				stream.write(dequant_table[i][j], 16);
			}
		}
		stream.write(0x64617461, 32); // "data"
		for(let f=0; f<reg_frames; f++) {
			fac_encode_FAST(stream, audio, offset, slice_len, frame_slices);
			offset += frame_len;
		}
		if(last_fr_slices) {
			fac_encode_FAST(stream, audio, offset, slice_len, last_fr_slices);
		}
	}
	stream.writeLast();
	return stream.bytes;
}


function fac_decode(data) {  // decoding function
	const stream = new BitStream(data);
	const header = decode_header(stream);
	const audio = header.playback_data;
	const config_data = header.config_data;
	if(audio.bitsPerSample < 1 || audio.bitsPerSample > 4) {
		throw new Error("Bits per sample out of range [1 - 4].");
	}
	const channelData = [];
	for(let c=0; c<audio.channels; c++) {
		const channel = new Int16Array(audio.samples);
		channelData.push(channel);
	}
	audio.channelData = channelData;
	const reg_frames = config_data.reg_frames;
	const reg_frame_slices = config_data.reg_frame_slices;
	const last_fr_slices = config_data.last_fr_slices;
	const slice_len = config_data.slice_len;
	const reg_frame_samples = reg_frame_slices * slice_len;
	const sampleCheck = reg_frames * reg_frame_samples + last_fr_slices * slice_len;
	if(sampleCheck != audio.samples) {
		throw new Error("Corrupted file header data.");
	}
	let offset = 0;
	const cell_size = 1 << audio.bitsPerSample;
	let dequant_tab = [];
	for(let i=0; i<16; i++) {
		dequant_tab.push(new Int16Array(cell_size));
		for(let j=0; j<cell_size; j++) {
			dequant_tab[i][j] = stream.read(16);
		}
	}
	stream.read(32); // "data" marker
	for(let f=0; f<reg_frames; f++) {
		fac_decode_frame(stream, audio, offset, reg_frame_slices, slice_len, dequant_tab);
		offset += reg_frame_samples;
	}
	if(last_fr_slices) {
		fac_decode_frame(stream, audio, offset, last_fr_slices, slice_len, dequant_tab);
	}
	return audio;
}

/* ======================================================================================== */
