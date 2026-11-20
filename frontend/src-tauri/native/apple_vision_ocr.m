#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static char *memo_dup_utf8(NSString *str) {
    if (str == nil) {
        char *empty = (char *)malloc(1);
        if (empty != NULL) {
            empty[0] = '\0';
        }
        return empty;
    }
    const char *utf8 = [str UTF8String];
    if (utf8 == NULL) {
        utf8 = "";
    }
    size_t len = strlen(utf8);
    char *copy = (char *)malloc(len + 1);
    if (copy != NULL) {
        memcpy(copy, utf8, len + 1);
    }
    return copy;
}

int32_t memo_apple_vision_recognize_rgba(
    const uint8_t *rgba,
    size_t rgba_len,
    uint32_t width,
    uint32_t height,
    char **out_text,
    char **out_error
) {
    if (out_text != NULL) {
        *out_text = NULL;
    }
    if (out_error != NULL) {
        *out_error = NULL;
    }
    if (rgba == NULL || width == 0 || height == 0) {
        if (out_error != NULL) {
            *out_error = memo_dup_utf8(@"invalid RGBA buffer dimensions");
        }
        return -1;
    }
    size_t expected = (size_t)width * (size_t)height * 4;
    if (rgba_len < expected) {
        if (out_error != NULL) {
            *out_error = memo_dup_utf8(@"RGBA buffer shorter than width * height * 4");
        }
        return -1;
    }

    @autoreleasepool {
        CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
        if (colorSpace == NULL) {
            if (out_error != NULL) {
                *out_error = memo_dup_utf8(@"could not create RGB color space");
            }
            return -1;
        }

        CGDataProviderRef provider = CGDataProviderCreateWithData(NULL, rgba, expected, NULL);
        if (provider == NULL) {
            CGColorSpaceRelease(colorSpace);
            if (out_error != NULL) {
                *out_error = memo_dup_utf8(@"could not create CGDataProvider");
            }
            return -1;
        }

        CGBitmapInfo bitmapInfo =
            (CGBitmapInfo)kCGImageAlphaLast | (CGBitmapInfo)kCGBitmapByteOrder32Big;
        CGImageRef cgImage = CGImageCreate(
            (size_t)width,
            (size_t)height,
            8,
            32,
            (size_t)width * 4,
            colorSpace,
            bitmapInfo,
            provider,
            NULL,
            false,
            kCGRenderingIntentDefault
        );

        CGDataProviderRelease(provider);
        CGColorSpaceRelease(colorSpace);

        if (cgImage == NULL) {
            if (out_error != NULL) {
                *out_error = memo_dup_utf8(@"could not construct CGImage from RGBA buffer");
            }
            return -1;
        }

        VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
        const char *fastEnv = getenv("MEMO_OCR_FAST");
        if (fastEnv != NULL && strcmp(fastEnv, "1") == 0) {
            request.recognitionLevel = VNRequestTextRecognitionLevelFast;
            request.usesLanguageCorrection = NO;
        } else {
            request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
            request.usesLanguageCorrection = YES;
        }

        VNImageRequestHandler *handler =
            [[VNImageRequestHandler alloc] initWithCGImage:cgImage options:@{}];
        NSError *visionError = nil;
        BOOL ok = [handler performRequests:@[ request ] error:&visionError];
        CGImageRelease(cgImage);

        if (!ok || visionError != nil) {
            if (out_error != NULL) {
                NSString *desc = visionError != nil
                    ? [visionError localizedDescription]
                    : @"Vision text recognition failed";
                *out_error = memo_dup_utf8(desc);
            }
            return -1;
        }

        NSMutableArray<NSString *> *lines = [NSMutableArray array];
        for (VNRecognizedTextObservation *observation in request.results) {
            VNRecognizedText *top = [[observation topCandidates:1] firstObject];
            if (top != nil && top.confidence >= 0.25f) {
                NSString *trimmed = [top.string
                    stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
                if (trimmed.length > 0) {
                    [lines addObject:trimmed];
                }
            }
        }

        NSString *joined = [lines componentsJoinedByString:@"\n"];
        if (out_text != NULL) {
            *out_text = memo_dup_utf8(joined);
        }
        return 0;
    }
}

void memo_apple_vision_free_string(char *ptr) {
    if (ptr != NULL) {
        free(ptr);
    }
}
