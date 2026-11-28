#import "BaseRenderer.h"
#import "RenderContext.h"

extern NSString *const ListDepthAttribute;
extern NSString *const ListTypeAttribute;
extern NSString *const ListItemNumberAttribute;
extern NSString *const ListItemMarkerStartAttribute;

extern NSString *const TaskItemAttribute;
extern NSString *const TaskCheckedAttribute;
extern NSString *const TaskIndexAttribute;

@interface ENRMListMarkerDescriptor : NSObject
@property (nonatomic, assign) BOOL isTask;
@property (nonatomic, assign) BOOL isChecked;
@property (nonatomic, assign) NSInteger taskIndex;
@property (nonatomic, assign) ListType listType;
@property (nonatomic, assign) NSInteger number;
@property (nonatomic, assign) NSInteger depth;
@property (nonatomic, assign) CGFloat indent;
@end

@interface ListItemRenderer : BaseRenderer
@end
